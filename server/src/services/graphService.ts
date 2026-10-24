import { FalkorDB, type Graph } from 'falkordb';
import { simpleGit } from 'simple-git';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { fileService, type FileTreeNode } from './fileService.js';
import type { BrainAnswer, BrainSource } from './brainService.js';
import { workspaceService } from './workspaceService.js';

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  '.git',
]);

const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'css',
  'html',
  'yml',
  'yaml',
  'toml',
  'go',
  'rs',
  'java',
  'rb',
  'prisma',
  'sql',
  'xml',
  'sh',
  'c',
  'h',
  'cpp',
  'cs',
  'php',
  'vue',
  'svelte',
]);

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'who',
  'how',
  'does',
  'did',
  'are',
  'was',
  'were',
  'can',
  'you',
  'our',
  'your',
  'about',
  'where',
  'when',
  'which',
  'into',
  'have',
  'has',
  'not',
  'folder',
  'folders',
  'file',
  'files',
  'there',
  'how',
  'all',
  'used',
  'using',
  'use',
  'being',
]);

const GRAPH_FRESH_MS = 20_000;
const GRAPH_VERSION = 2;
const MAX_DOCUMENTS = 80;
const MAX_ASSETS = 80;
const MAX_COMMITS = 20;
const ANSWER_CHAR_LIMIT = 1_600;

const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'mp3',
  'mp4',
  'pdf',
]);

type GraphRow = Record<string, string>;

let connection: Promise<FalkorDB> | null = null;
const syncs = new Map<string, Promise<void>>();

function graphName(workspaceId: string): string {
  return `together_${workspaceId.replaceAll('-', '')}`;
}

function getConnection(): Promise<FalkorDB> {
  connection ??= FalkorDB.connect({
    socket: {
      host: env.FALKORDB_HOST,
      port: env.FALKORDB_PORT,
    },
  }).catch((error: unknown) => {
    connection = null;
    throw error;
  });

  return connection;
}

function isUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code.toLowerCase()
      : '';
  const nested =
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray(error.errors)
      ? error.errors.some((item) => isUnavailable(item))
      : false;

  return (
    nested ||
    code === 'econnrefused' ||
    code === 'econnreset' ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('connect')
  );
}

function asGraphError(error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }

  if (isUnavailable(error)) {
    throw new HttpError(503, 'FalkorDB is not running, so the workspace graph cannot answer yet.');
  }

  throw error;
}

type CypherValue =
  string | number | boolean | null | CypherValue[] | { [key: string]: CypherValue };

async function queryGraph(
  workspaceId: string,
  cypher: string,
  params: { [key: string]: CypherValue },
) {
  try {
    const database = await getConnection();
    return await database.selectGraph(graphName(workspaceId)).query(cypher, {
      params: params as never,
    });
  } catch (error) {
    asGraphError(error);
  }
}

function rowsFrom(result: { headers?: string[]; data?: unknown } | undefined): GraphRow[] {
  if (!result || !Array.isArray(result.data)) {
    return [];
  }

  return result.data.map((row) => {
    const record: GraphRow = {};
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const [header, value] of Object.entries(row)) {
        record[header] = value == null ? '' : String(value);
      }
      return record;
    }

    const values = Array.isArray(row) ? row : [];
    result.headers?.forEach((header, index) => {
      const value = values[index];
      record[header] = value == null ? '' : String(value);
    });
    return record;
  });
}

function termsFromQuestion(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
    ),
  ].slice(0, 8);
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function flattenFiles(nodes: FileTreeNode[], textFiles: string[], assetFiles: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'directory') {
      if (!SKIPPED_DIRECTORIES.has(node.name) && node.children) {
        flattenFiles(node.children, textFiles, assetFiles);
      }
      continue;
    }

    const extension = extensionOf(node.path);
    if (TEXT_EXTENSIONS.has(extension)) {
      textFiles.push(node.path);
    } else if (ASSET_EXTENSIONS.has(extension)) {
      assetFiles.push(node.path);
    }
  }
}

function searchTerms(terms: string[]): string[] {
  const expanded = terms.flatMap((term) =>
    term === 'assets' ? [term, 'assests'] : term === 'assests' ? [term, 'assets'] : [term],
  );
  return [...new Set(expanded)].slice(0, 10);
}

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

async function readDocuments(workspaceId: string) {
  const textFiles: string[] = [];
  const assetFiles: string[] = [];
  flattenFiles(await fileService.listTree(workspaceId), textFiles, assetFiles);
  const documents: Array<{ path: string; name: string; excerpt: string }> = [];

  for (const path of textFiles.slice(0, MAX_DOCUMENTS)) {
    const name = path.split('/').pop() ?? path;
    try {
      const file = await fileService.readTextFile(workspaceId, path);
      documents.push({ path, name, excerpt: clip(file.content, 1_200) });
    } catch (error) {
      if (error instanceof HttpError) {
        documents.push({ path, name, excerpt: '' });
        continue;
      }
      throw error;
    }
  }

  for (const path of assetFiles.slice(0, MAX_ASSETS)) {
    const name = path.split('/').pop() ?? path;
    const folder = path.split('/').slice(0, -1).join('/') || 'the project root';
    documents.push({
      path,
      name,
      excerpt: `${extensionOf(path).toUpperCase()} file in ${folder}.`,
    });
  }

  return documents;
}

async function readDecisions(workspaceId: string, documents: Array<{ path: string }>) {
  const knownPaths = new Set(documents.map((document) => document.path));
  try {
    const git = simpleGit({ baseDir: workspaceService.getRoot(workspaceId) });
    const log = await git.log({ maxCount: MAX_COMMITS });
    const decisions = [];

    for (const entry of log.all) {
      const names = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', entry.hash]);
      const files = names
        .split('\n')
        .map((path) => path.trim())
        .filter((path) => knownPaths.has(path));
      decisions.push({
        sha: entry.hash,
        message: clip(entry.message, 240),
        authorName: entry.author_name,
        files,
      });
    }

    return decisions;
  } catch {
    return [];
  }
}

async function syncWorkspace(workspaceId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      repoFullName: true,
      status: true,
      members: {
        select: { role: true, user: { select: { id: true, username: true } } },
        orderBy: { joinedAt: 'asc' },
      },
    },
  });

  if (!workspace) {
    throw new HttpError(404, 'Workspace not found.');
  }

  if (workspace.status !== 'READY') {
    throw new HttpError(409, 'This workspace is not ready to search yet.');
  }

  const database = await getConnection();
  const graph = database.selectGraph(graphName(workspaceId));
  let builtAt = 0;

  try {
    const existing = await graph.roQuery(
      'MATCH (project:Project {id: $workspaceId}) RETURN project.builtAt AS builtAt, project.graphVersion AS graphVersion',
      { params: { workspaceId } },
    );
    const row = rowsFrom(existing)[0];
    builtAt = Number(row?.builtAt ?? 0);
    const graphVersion = Number(row?.graphVersion ?? 0);
    if (graphVersion !== GRAPH_VERSION) {
      builtAt = 0;
    }
  } catch (error) {
    if (error instanceof HttpError || isUnavailable(error)) {
      asGraphError(error);
    }
  }

  if (builtAt > 0 && Date.now() - builtAt < GRAPH_FRESH_MS) {
    return;
  }

  const rememberedAnswers = await readSavedAnswers(graph);

  try {
    await graph.delete();
  } catch (error) {
    if (isUnavailable(error)) {
      asGraphError(error);
    }
  }

  const people = workspace.members.map((member) => ({
    id: member.user.id,
    username: member.user.username,
    role: member.role,
  }));
  const documents = await readDocuments(workspaceId);
  const decisions = await readDecisions(workspaceId, documents);
  const messages = await prisma.chatMessage.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      content: true,
      createdAt: true,
      user: { select: { id: true, username: true } },
    },
  });

  await graph.query(
    `CREATE (:Project {id: $workspaceId, name: $name, repo: $repo, builtAt: $builtAt, graphVersion: $graphVersion})`,
    {
      params: {
        workspaceId,
        name: workspace.name,
        repo: workspace.repoFullName,
        builtAt: Date.now(),
        graphVersion: GRAPH_VERSION,
      },
    },
  );

  if (people.length > 0) {
    await graph.query(
      `UNWIND $people AS person
       CREATE (p:Person {id: person.id, username: person.username})
       WITH p, person
       MATCH (project:Project {id: $workspaceId})
       CREATE (p)-[:MEMBER_OF {role: person.role}]->(project)`,
      { params: { people, workspaceId } },
    );
    const owners = people.filter((person) => person.role === 'OWNER');
    if (owners.length > 0) {
      await graph.query(
        `UNWIND $owners AS person
         MATCH (p:Person {id: person.id}), (project:Project {id: $workspaceId})
         CREATE (p)-[:OWNS]->(project)`,
        { params: { owners, workspaceId } },
      );
    }
  }

  if (documents.length > 0) {
    await graph.query(
      `UNWIND $documents AS document
       CREATE (d:Document {path: document.path, name: document.name, excerpt: document.excerpt})
       WITH d
       MATCH (project:Project {id: $workspaceId})
       CREATE (d)-[:PART_OF]->(project)`,
      { params: { documents, workspaceId } },
    );
  }

  if (decisions.length > 0) {
    await graph.query(
      `UNWIND $decisions AS decision
       CREATE (d:Decision {sha: decision.sha, message: decision.message, authorName: decision.authorName})
       WITH d
       MATCH (project:Project {id: $workspaceId})
       CREATE (d)-[:IN]->(project)`,
      {
        params: {
          decisions: decisions.map(({ sha, message, authorName }) => ({
            sha,
            message,
            authorName,
          })),
          workspaceId,
        },
      },
    );
    const changes = decisions.flatMap((decision) =>
      decision.files.map((path) => ({ sha: decision.sha, path })),
    );
    if (changes.length > 0) {
      await graph.query(
        `UNWIND $changes AS change
         MATCH (decision:Decision {sha: change.sha}), (document:Document {path: change.path})
         CREATE (decision)-[:CHANGES]->(document)`,
        { params: { changes } },
      );
    }
    await graph.query(
      `UNWIND $decisions AS decision
       MATCH (d:Decision {sha: decision.sha}), (person:Person)
       WHERE toLower(decision.authorName) CONTAINS toLower(person.username)
          OR toLower(person.username) CONTAINS toLower(decision.authorName)
       CREATE (d)-[:DECIDED_BY]->(person)`,
      {
        params: {
          decisions: decisions.map(({ sha, authorName }) => ({ sha, authorName })),
        },
      },
    );
  }

  if (messages.length > 0) {
    await graph.query(
      `UNWIND $messages AS message
       CREATE (m:Message {id: message.id, content: message.content, username: message.username, channel: message.channel, createdAt: message.createdAt})
       WITH m, message
       MATCH (project:Project {id: $workspaceId})
       CREATE (m)-[:ABOUT]->(project)
       WITH m, message
       MATCH (person:Person {id: message.userId})
       CREATE (m)-[:SAID_BY]->(person)`,
      {
        params: {
          workspaceId,
          messages: messages.map((message) => ({
            id: message.id,
            content: clip(message.content, 300),
            username: message.user.username,
            channel: 'chat',
            createdAt: message.createdAt.getTime(),
            userId: message.user.id,
          })),
        },
      },
    );
  }

  await restoreAnswers(graph, rememberedAnswers);
}

function scheduleSync(workspaceId: string): Promise<void> {
  const current = syncs.get(workspaceId);
  if (current) {
    return current;
  }

  const pending = syncWorkspace(workspaceId).finally(() => {
    syncs.delete(workspaceId);
  });
  syncs.set(workspaceId, pending);
  return pending;
}

type Seed = { label: string; key: string };
type LinkedSource = BrainSource & { linkLabel: string; linkKey: string };
type SavedLink = { label: string; key: string };
type SavedAnswer = {
  id: string;
  question: string;
  text: string;
  createdAt: number;
  links: SavedLink[];
};

function labelName(value: string | undefined): string {
  const match = value?.match(/[A-Za-z_]+/);
  return match?.[0] ?? '';
}

function sourceKey(source: BrainSource): string {
  return `${source.kind}:${source.title}:${source.excerpt}`;
}

async function readSavedAnswers(graph: Graph): Promise<SavedAnswer[]> {
  try {
    const result = await graph.roQuery(
      `MATCH (answer:Answer)
       OPTIONAL MATCH (answer)-[:BASED_ON]->(node)
       RETURN answer.id AS id, answer.question AS question, answer.text AS text,
              answer.createdAt AS createdAt, labels(node) AS label,
              coalesce(node.path, node.sha, node.id, '') AS key`,
    );
    const grouped = new Map<string, SavedAnswer>();
    for (const row of rowsFrom(result)) {
      const id = row.id ?? '';
      if (!id) continue;
      const current = grouped.get(id) ?? {
        id,
        question: row.question ?? '',
        text: row.text ?? '',
        createdAt: Number(row.createdAt ?? 0),
        links: [],
      };
      const label = labelName(row.label);
      const key = row.key ?? '';
      if (label && key) {
        current.links.push({ label, key });
      }
      grouped.set(id, current);
    }
    return [...grouped.values()];
  } catch (error) {
    if (isUnavailable(error)) {
      asGraphError(error);
    }
    return [];
  }
}

async function restoreAnswers(graph: Graph, answers: SavedAnswer[]): Promise<void> {
  for (const answer of answers) {
    await graph.query(
      `CREATE (:Answer {id: $id, question: $question, text: $text, createdAt: $createdAt})`,
      {
        params: {
          id: answer.id,
          question: answer.question,
          text: answer.text,
          createdAt: answer.createdAt,
        },
      },
    );
    for (const link of answer.links) {
      const match =
        link.label === 'Document'
          ? 'MATCH (answer:Answer {id: $id}), (node:Document {path: $key})'
          : link.label === 'Person'
            ? 'MATCH (answer:Answer {id: $id}), (node:Person {id: $key})'
            : link.label === 'Decision'
              ? 'MATCH (answer:Answer {id: $id}), (node:Decision {sha: $key})'
              : link.label === 'Message'
                ? 'MATCH (answer:Answer {id: $id}), (node:Message {id: $key})'
                : '';
      if (!match) continue;
      await graph.query(`${match} CREATE (answer)-[:BASED_ON]->(node)`, {
        params: { id: answer.id, key: link.key },
      });
    }
  }
}

async function findSeeds(workspaceId: string, terms: string[]): Promise<Seed[]> {
  const lookup = searchTerms(terms);
  if (lookup.length === 0) return [];
  const queries: Array<{ cypher: string; label: string }> = [
    {
      label: 'Person',
      cypher: `UNWIND $terms AS term
               MATCH (person:Person)
               WHERE toLower(person.username) CONTAINS term
               RETURN person.id AS key LIMIT 8`,
    },
    {
      label: 'Document',
      cypher: `UNWIND $terms AS term
               MATCH (document:Document)
               WHERE toLower(document.path) CONTAINS term
                  OR toLower(document.name) CONTAINS term
                  OR toLower(document.excerpt) CONTAINS term
               RETURN document.path AS key LIMIT 20`,
    },
    {
      label: 'Decision',
      cypher: `UNWIND $terms AS term
               MATCH (decision:Decision)
               WHERE toLower(decision.message) CONTAINS term
                  OR toLower(decision.authorName) CONTAINS term
               RETURN decision.sha AS key LIMIT 8`,
    },
    {
      label: 'Message',
      cypher: `UNWIND $terms AS term
               MATCH (message:Message)
               WHERE toLower(message.content) CONTAINS term
                  OR toLower(message.username) CONTAINS term
                  OR toLower(message.channel) CONTAINS term
               RETURN message.id AS key LIMIT 8`,
    },
    {
      label: 'Answer',
      cypher: `UNWIND $terms AS term
               MATCH (answer:Answer)
               WHERE toLower(answer.question) CONTAINS term
                  OR toLower(answer.text) CONTAINS term
               RETURN answer.id AS key LIMIT 4`,
    },
  ];
  const seeds: Seed[] = [];
  for (const query of queries) {
    const found = rowsFrom(await queryGraph(workspaceId, query.cypher, { terms: lookup }));
    for (const row of found) {
      if (!row.key) continue;
      if (seeds.some((seed) => seed.label === query.label && seed.key === row.key)) continue;
      seeds.push({ label: query.label, key: row.key });
    }
  }
  return seeds.slice(0, 8);
}

async function edgeTypesForSeeds(workspaceId: string, seeds: Seed[]): Promise<Set<string>> {
  const edges = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const seed of seeds) {
    const keys = groups.get(seed.label) ?? [];
    keys.push(seed.key);
    groups.set(seed.label, keys);
  }
  const property: Record<string, string> = {
    Person: 'id',
    Document: 'path',
    Decision: 'sha',
    Message: 'id',
    Answer: 'id',
    Project: 'id',
  };
  for (const [label, keys] of groups) {
    const field = property[label];
    if (!field) continue;
    const rows = rowsFrom(
      await queryGraph(
        workspaceId,
        `UNWIND $keys AS key
         MATCH (node:${label} {${field}: key})-[rel]-()
         RETURN DISTINCT type(rel) AS relType`,
        { keys },
      ),
    );
    for (const row of rows) {
      const relType = labelName(row.relType);
      if (relType) edges.add(relType);
    }
  }
  return edges;
}

async function edgeTypesMatchingTerms(workspaceId: string, terms: string[]): Promise<Set<string>> {
  if (terms.length === 0) return new Set();
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `UNWIND $terms AS term
       MATCH ()-[rel]->()
       WHERE toLower(type(rel)) CONTAINS term
       RETURN DISTINCT type(rel) AS relType
       LIMIT 8`,
      { terms },
    ),
  );
  return new Set(rows.map((row) => labelName(row.relType)).filter(Boolean));
}

async function latestAnswer(workspaceId: string): Promise<Seed | null> {
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (answer:Answer)
       RETURN answer.id AS key
       ORDER BY answer.createdAt DESC
       LIMIT 1`,
      {},
    ),
  );
  const key = rows[0]?.key;
  return key ? { label: 'Answer', key } : null;
}

function hasEdge(edges: Set<string>, names: string[]): boolean {
  return names.some((name) => edges.has(name));
}

async function peopleAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!hasEdge(edges, ['OWNS', 'MEMBER_OF'])) return [];
  const personIds = seeds.filter((seed) => seed.label === 'Person').map((seed) => seed.key);
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      personIds.length > 0
        ? `UNWIND $personIds AS personId
           MATCH (person:Person {id: personId})-[membership:MEMBER_OF]->(:Project {id: $workspaceId})
           RETURN person.id AS linkKey, person.username AS username, membership.role AS role`
        : edges.has('OWNS')
          ? `MATCH (person:Person)-[:OWNS]->(:Project {id: $workspaceId})
             RETURN person.id AS linkKey, person.username AS username, 'OWNER' AS role`
          : `MATCH (person:Person)-[membership:MEMBER_OF]->(:Project {id: $workspaceId})
             RETURN person.id AS linkKey, person.username AS username, membership.role AS role
             LIMIT 4`,
      { workspaceId, personIds },
    ),
  );
  return rows.slice(0, 4).map((person) => {
    const role = person.role === 'OWNER' ? 'owner' : 'collaborator';
    const username = person.username ?? 'Unknown';
    return {
      kind: 'member' as const,
      title: username,
      excerpt: `${username} is the ${role} of this workspace.`,
      linkLabel: 'Person',
      linkKey: person.linkKey ?? username,
    };
  });
}

async function decisionAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!hasEdge(edges, ['CHANGES', 'DECIDED_BY'])) return [];
  const shas = seeds.filter((seed) => seed.label === 'Decision').map((seed) => seed.key);
  const paths = seeds.filter((seed) => seed.label === 'Document').map((seed) => seed.key);
  if (shas.length === 0 && paths.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (decision:Decision)-[:CHANGES]->(document:Document)
       WHERE decision.sha IN $shas OR document.path IN $paths
       RETURN decision.sha AS linkKey, decision.message AS message, decision.authorName AS author, document.path AS path
       LIMIT 3`,
      { shas, paths },
    ),
  );
  return rows.map((decision) => ({
    kind: 'decision' as const,
    title: decision.path || 'Commit',
    ...(decision.path ? { path: decision.path } : {}),
    excerpt: `${decision.author ?? 'Someone'} — ${decision.message ?? ''}`,
    linkLabel: 'Decision',
    linkKey: decision.linkKey ?? '',
  }));
}

async function chatAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!edges.has('SAID_BY')) return [];
  const messageIds = seeds.filter((seed) => seed.label === 'Message').map((seed) => seed.key);
  const personIds = seeds.filter((seed) => seed.label === 'Person').map((seed) => seed.key);
  if (messageIds.length === 0 && personIds.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      messageIds.length > 0
        ? `UNWIND $messageIds AS messageId
           MATCH (message:Message {id: messageId})-[:SAID_BY]->(person:Person)
           RETURN message.id AS linkKey, person.username AS username, message.content AS content
           LIMIT 3`
        : `UNWIND $personIds AS personId
           MATCH (message:Message)-[:SAID_BY]->(person:Person {id: personId})
           RETURN message.id AS linkKey, person.username AS username, message.content AS content
           ORDER BY message.createdAt DESC
           LIMIT 3`,
      { messageIds, personIds },
    ),
  );
  return rows.map((message) => ({
    kind: 'chat' as const,
    title: `Chat · ${message.username ?? 'someone'}`,
    excerpt: message.content ?? '',
    linkLabel: 'Message',
    linkKey: message.linkKey ?? '',
  }));
}

async function documentsMatching(
  workspaceId: string,
  terms: string[],
  matchExcerpt: boolean,
): Promise<Array<{ path: string; excerpt: string }>> {
  if (terms.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      matchExcerpt
        ? `UNWIND $terms AS term
           MATCH (document:Document)-[:PART_OF]->(:Project {id: $workspaceId})
           WHERE toLower(document.excerpt) CONTAINS term
           RETURN DISTINCT document.path AS path, document.excerpt AS excerpt
           LIMIT 40`
        : `UNWIND $terms AS term
           MATCH (document:Document)-[:PART_OF]->(:Project {id: $workspaceId})
           WHERE toLower(document.path) CONTAINS term
              OR toLower(document.name) CONTAINS term
           RETURN DISTINCT document.path AS path, document.excerpt AS excerpt
           LIMIT 40`,
      { workspaceId, terms },
    ),
  );
  return rows
    .filter((row) => row.path)
    .map((row) => ({ path: row.path ?? '', excerpt: row.excerpt ?? '' }));
}

async function fileAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
  terms: string[],
): Promise<LinkedSource[]> {
  if (!edges.has('PART_OF')) return [];
  const lookup = searchTerms(terms);
  let matched = await documentsMatching(workspaceId, lookup, false);
  if (matched.length === 0) {
    matched = await documentsMatching(workspaceId, lookup, true);
  }
  const strict = matched.filter((document) => {
    const name = document.path.split('/').pop() ?? '';
    const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
    const segments = document.path.toLowerCase().split('/');
    return lookup.some((term) => stem === term || segments.includes(term));
  });
  if (strict.length > 0) matched = strict;

  if (matched.length === 0) {
    const paths = seeds.filter((seed) => seed.label === 'Document').map((seed) => seed.key);
    if (paths.length === 0) return [];
    const rows = rowsFrom(
      await queryGraph(
        workspaceId,
        `UNWIND $paths AS path
         MATCH (document:Document {path: path})-[:PART_OF]->(:Project {id: $workspaceId})
         RETURN document.path AS path, document.excerpt AS excerpt`,
        { workspaceId, paths },
      ),
    );
    matched = rows
      .filter((row) => row.path)
      .map((row) => ({ path: row.path ?? '', excerpt: row.excerpt ?? '' }));
  }

  return matched.map((document) => ({
    kind: 'file' as const,
    title: document.path,
    path: document.path,
    excerpt: document.excerpt || 'File in this workspace.',
    linkLabel: 'Document',
    linkKey: document.path,
  }));
}

async function sourcesFromAnswer(workspaceId: string, answerId: string): Promise<LinkedSource[]> {
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (answer:Answer {id: $answerId})-[:BASED_ON]->(node)
       OPTIONAL MATCH (node)-[membership:MEMBER_OF]->(:Project)
       OPTIONAL MATCH (node)-[:CHANGES]->(document:Document)
       RETURN labels(node) AS label,
              coalesce(node.id, node.path, node.sha, '') AS linkKey,
              coalesce(document.path, node.path, '') AS path,
              coalesce(node.username, node.authorName, '') AS actor,
              coalesce(node.message, node.content, node.excerpt, '') AS excerpt,
              membership.role AS role`,
      { answerId },
    ),
  );
  return rows.flatMap((row): LinkedSource[] => {
    const label = labelName(row.label);
    const linkKey = row.linkKey ?? '';
    if (!label || !linkKey) return [];
    if (label === 'Person') {
      const role = row.role === 'OWNER' ? 'owner' : 'collaborator';
      const username = row.actor || 'Unknown';
      return [
        {
          kind: 'member' as const,
          title: username,
          excerpt: `${username} is the ${role} of this workspace.`,
          linkLabel: 'Person',
          linkKey,
        },
      ];
    }
    if (label === 'Decision') {
      return [
        {
          kind: 'decision' as const,
          title: row.path || 'Commit',
          ...(row.path ? { path: row.path } : {}),
          excerpt: `${row.actor || 'Someone'} — ${row.excerpt ?? ''}`,
          linkLabel: 'Decision',
          linkKey,
        },
      ];
    }
    if (label === 'Message') {
      return [
        {
          kind: 'chat' as const,
          title: `Chat · ${row.actor || 'someone'}`,
          excerpt: row.excerpt ?? '',
          linkLabel: 'Message',
          linkKey,
        },
      ];
    }
    return [
      {
        kind: 'file' as const,
        title: row.path || 'File',
        ...(row.path ? { path: row.path } : {}),
        excerpt: row.excerpt || 'File linked to the previous answer.',
        linkLabel: 'Document',
        linkKey,
      },
    ];
  });
}

function answerText(sources: BrainSource[]): string {
  if (sources.length === 0) {
    return 'The FalkorDB graph has no linked source for that question.';
  }
  return sources.map((source) => `${source.title}: ${source.excerpt}`).join('\n\n');
}

function joinList(items: string[]): string {
  const unique = [...new Set(items.filter(Boolean))];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0] ?? '';
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function arrayBlock(content: string, name: string): string {
  const marker = `export const ${name}`;
  const start = content.indexOf(marker);
  if (start < 0) return '';
  const equals = content.indexOf('=', start);
  const open = content.indexOf('[', equals);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '[') depth += 1;
    if (content[index] === ']') {
      depth -= 1;
      if (depth === 0) return content.slice(open, index + 1);
    }
  }
  return '';
}

function quoted(block: string, field: string): string[] {
  return [...block.matchAll(new RegExp(`${field}:\\s*(["'])([\\s\\S]*?)\\1`, 'g'))].map(
    (match) => match[2] ?? '',
  );
}

function lineValue(line: string, field: string): string {
  return line.match(new RegExp(`${field}:\\s*(["'])([\\s\\S]*?)\\1`))?.[2] ?? '';
}

function explainModule(path: string, content: string): string {
  const experiences = arrayBlock(content, 'experiences');
  const projects = arrayBlock(content, 'projects');
  const certificates = arrayBlock(content, 'certificates');
  const roles = [...experiences.matchAll(/role:\s*["']([^"']+)["'][\s\S]*?company:\s*["']([^"']+)["']/g)];
  const projectTitles = quoted(projects, 'title');
  const certificateTitles = quoted(certificates, 'title');
  const sentences = [`${path} holds the portfolio content.`];

  if (roles.length > 0) {
    sentences.push(
      `Jobs: ${joinList(roles.map((match) => `${match[1]} at ${match[2]}`))}.`,
    );
  }
  if (projectTitles.length > 0) sentences.push(`Projects: ${joinList(projectTitles)}.`);
  if (certificateTitles.length > 0) sentences.push(`Certificates: ${joinList(certificateTitles)}.`);
  if (content.includes('./Assests/')) sentences.push('Images are imported from the Assests folder.');

  return sentences.join(' ');
}

function explainGenericFile(path: string, content: string): string {
  const exports = [
    ...content.matchAll(/export (?:default )?(?:async )?(?:function|const|class|type|interface) (\w+)/g),
  ].map((match) => match[1] ?? '');
  const localImports = [...content.matchAll(/from ['"](\.[^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
  const sentences = [`${path}.`];
  if (exports.length > 0) sentences.push(`Exports ${joinList(exports.slice(0, 6))}.`);
  if (localImports.length > 0) {
    sentences.push(`Imports ${joinList(localImports.slice(0, 5))}.`);
  }
  return sentences.join(' ');
}

function matchingFolders(terms: string[], paths: string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const lowered = part.toLowerCase();
      if (terms.some((term) => lowered.includes(term) || term.includes(lowered))) {
        folders.add(current);
      }
    }
  }
  return [...folders].filter(
    (folder) => ![...folders].some((other) => other !== folder && folder.startsWith(`${other}/`)),
  );
}

function usageOf(assetName: string, contents: Map<string, string>): string[] {
  const notes: string[] = [];
  for (const [path, content] of contents) {
    if (path.endsWith(assetName)) continue;
    const lines = content.split('\n');
    const importIndex = lines.findIndex(
      (line) => line.includes(assetName) && line.includes('import'),
    );
    if (importIndex < 0) {
      const mention = lines.find((line) => line.includes(assetName));
      if (mention) notes.push(`${path} mentions it: ${mention.trim()}.`);
      continue;
    }
    const variable = lines[importIndex]?.match(/import\s+(\w+)/)?.[1];
    if (!variable) {
      notes.push(`${path} imports ${assetName}.`);
      continue;
    }
    const uses = lines.flatMap((line, index) =>
      index !== importIndex && new RegExp(`\\b${variable}\\b`).test(line) ? [{ line, index }] : [],
    );
    if (uses.length === 0) {
      notes.push(`${path} imports it as ${variable}.`);
      continue;
    }
    const described = uses.map(({ line, index }) => {
      let title = '';
      let role = '';
      let company = '';
      for (let cursor = index; cursor >= Math.max(0, index - 30); cursor -= 1) {
        const current = lines[cursor] ?? '';
        title ||= lineValue(current, 'title');
        role ||= lineValue(current, 'role');
        company ||= lineValue(current, 'company');
        if (title || (role && company)) break;
      }
      const field = line.match(/(\w+)\s*:/)?.[1];
      const subject = title || (role && company ? `${role} at ${company}` : '');
      const file = path.split('/').pop()?.replace(/\.[^.]+$/, '') || path;
      if (line.includes('src={') || line.includes('<img')) return file;
      if (subject) return subject;
      return file;
    });
    notes.push(joinList(described));
  }
  return notes;
}

async function readWorkspaceText(workspaceId: string): Promise<Map<string, string>> {
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (document:Document)-[:PART_OF]->(:Project {id: $workspaceId})
       RETURN document.path AS path
       LIMIT 120`,
      { workspaceId },
    ),
  );
  const contents = new Map<string, string>();
  for (const row of rows) {
    const path = row.path ?? '';
    if (!path || !TEXT_EXTENSIONS.has(extensionOf(path))) continue;
    try {
      contents.set(path, (await fileService.readTextFile(workspaceId, path)).content);
    } catch (error) {
      if (error instanceof HttpError) continue;
      throw error;
    }
  }
  return contents;
}

function explainFolder(
  folder: string,
  paths: string[],
  contents: Map<string, string>,
): string {
  const inside = paths
    .filter((path) => path === folder || path.startsWith(`${folder}/`))
    .sort();
  const groups = new Map<string, string[]>();
  for (const path of inside) {
    const relative = path.slice(folder.length).replace(/^\//, '');
    const group = relative.includes('/') ? (relative.split('/')[0] ?? 'files') : 'files';
    const name = path.split('/').pop() ?? path;
    const current = groups.get(group) ?? [];
    current.push(name);
    groups.set(group, current);
  }

  const imageCount = inside.filter((path) => ASSET_EXTENSIONS.has(extensionOf(path))).length;
  const allImages = imageCount === inside.length && inside.length > 0;
  if (!allImages) {
    const named = [...groups.entries()].map(([group, names]) => {
      const stems = names.map((name) => name.replace(/\.[^.]+$/, ''));
      const where = group === 'files' ? 'alongside those' : `in ${group}`;
      return group === 'files'
        ? joinList(stems)
        : `${joinList(stems)} ${where}`;
    });
    return `The ${folder} folder has ${inside.length} files: ${named.join(', and ')}.`;
  }

  const sentences = [
    `The ${folder} folder has ${inside.length} image${inside.length === 1 ? '' : 's'}.`,
  ];
  for (const [group, names] of groups) {
    names.forEach((name, index) => {
      const notes = usageOf(name, contents);
      const place = group === 'files' ? '' : `In ${group}, `;
      const lead = index === 0 ? place : '';
      if (notes.length === 0) {
        sentences.push(`${lead}${name} is stored here and no source file imports it.`);
        return;
      }
      const screenFiles = new Set(
        [...contents.keys()].map((path) => path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''),
      );
      const shownOnScreen = notes.every((note) => screenFiles.has(note));
      const usedAsLogo = notes.every((note) => note.includes(' at '));
      const use = shownOnScreen
        ? `is the image shown in ${joinList(notes)}`
        : usedAsLogo
          ? `is the logo for ${joinList(notes)}`
          : `is the image for ${joinList(notes.map((note) => (note.split(/\s+/).length >= 3 ? `the ${note}` : note)))}`;
      sentences.push(`${lead}${name} ${use}.`);
    });
  }
  return sentences.join(' ');
}

async function composeLongAnswer(
  workspaceId: string,
  question: string,
  sources: LinkedSource[],
): Promise<string> {
  const files = sources.filter((source) => source.kind === 'file' && source.path);
  const paths = files.map((source) => source.path ?? '');
  const contents = paths.length > 0 ? await readWorkspaceText(workspaceId) : new Map<string, string>();
  const sections: string[] = [];
  const folders = matchingFolders(searchTerms(termsFromQuestion(question)), paths);
  const covered = new Set<string>();

  for (const folder of folders) {
    sections.push(explainFolder(folder, paths, contents));
    for (const path of paths) {
      if (path === folder || path.startsWith(`${folder}/`)) covered.add(path);
    }
  }

  for (const path of paths) {
    if (covered.has(path) || ASSET_EXTENSIONS.has(extensionOf(path))) continue;
    const content = contents.get(path);
    if (!content) continue;
    const rich = content.includes('export const experiences') || content.includes('export const projects');
    sections.push(rich ? explainModule(path, content) : explainGenericFile(path, content));
  }

  const other = sources
    .filter((source) => source.kind !== 'file')
    .map((source) => `${source.title}: ${source.excerpt}`);
  if (other.length > 0) sections.push(other.join('\n\n'));
  if (sections.length === 0) return answerText(sources);

  const text = sections.join('\n\n');
  if (text.length <= ANSWER_CHAR_LIMIT) return text;
  const cut = text.slice(0, ANSWER_CHAR_LIMIT);
  const breakAt = cut.lastIndexOf('. ');
  return (breakAt > 200 ? cut.slice(0, breakAt + 1) : cut).trim();
}

async function writeAnswer(
  workspaceId: string,
  question: string,
  sources: LinkedSource[],
): Promise<{ text: string; sources: BrainAnswer['sources'] }> {
  const answerId = `ans_${Date.now()}`;
  await queryGraph(
    workspaceId,
    `CREATE (:Answer {id: $answerId, question: $question, text: '', createdAt: $createdAt})`,
    { answerId, question, createdAt: Date.now() },
  );
  const matchByLabel: Record<string, string> = {
    Document: 'MATCH (answer:Answer {id: $answerId}), (node:Document {path: $key})',
    Person: 'MATCH (answer:Answer {id: $answerId}), (node:Person {id: $key})',
    Decision: 'MATCH (answer:Answer {id: $answerId}), (node:Decision {sha: $key})',
    Message: 'MATCH (answer:Answer {id: $answerId}), (node:Message {id: $key})',
  };
  for (const source of sources) {
    const match = matchByLabel[source.linkLabel];
    if (!match || !source.linkKey) continue;
    await queryGraph(workspaceId, `${match} CREATE (answer)-[:BASED_ON]->(node)`, {
      answerId,
      key: source.linkKey,
    });
  }
  const linked = await sourcesFromAnswer(workspaceId, answerId);
  const text = await composeLongAnswer(workspaceId, question, linked);
  await queryGraph(workspaceId, `MATCH (answer:Answer {id: $answerId}) SET answer.text = $text`, {
    answerId,
    text,
  });
  return {
    text,
    sources: linked.slice(0, 12).map((source) => ({
      kind: source.kind,
      title: source.title,
      excerpt: clip(source.excerpt, 220),
      ...(source.path ? { path: source.path } : {}),
    })),
  };
}

export class GraphService {
  async ask(workspaceId: string, question: string): Promise<BrainAnswer> {
    try {
      await scheduleSync(workspaceId);
    } catch (error) {
      asGraphError(error);
    }

    const terms = termsFromQuestion(question);
    const trace = ['Context agent'];
    let seeds = await findSeeds(workspaceId, terms);
    let edges = new Set<string>([
      ...(await edgeTypesForSeeds(workspaceId, seeds)),
      ...(await edgeTypesMatchingTerms(workspaceId, terms)),
    ]);

    const entitySeeds = seeds.filter((seed) => seed.label !== 'Answer');
    if (
      entitySeeds.length === 0 &&
      !hasEdge(edges, ['OWNS', 'MEMBER_OF', 'CHANGES', 'DECIDED_BY', 'SAID_BY', 'PART_OF'])
    ) {
      const previous = await latestAnswer(workspaceId);
      if (previous) {
        trace.push('Context agent opened the previous Answer');
        const recalled = (await sourcesFromAnswer(workspaceId, previous.key)).slice(0, 5);
        const written = await writeAnswer(workspaceId, question, recalled);
        trace.push('Action agent read BASED_ON and wrote Answer');
        return { answer: written.text, sources: written.sources, trace };
      }
    }

    if (seeds.length === 0 && edges.size === 0) {
      seeds = [{ label: 'Project', key: workspaceId }];
      edges = await edgeTypesForSeeds(workspaceId, seeds);
    }

    const seedLabels = [...new Set(seeds.map((seed) => seed.label))];
    trace.push(
      `Context agent found ${seedLabels.join(', ') || 'no nodes'}; edges ${[...edges].join(', ') || 'none'}`,
    );

    const found: LinkedSource[] = [];
    if (hasEdge(edges, ['OWNS', 'MEMBER_OF'])) {
      trace.push('People agent, because OWNS or MEMBER_OF');
      found.push(...(await peopleAgent(workspaceId, seeds, edges)));
    }
    if (hasEdge(edges, ['CHANGES', 'DECIDED_BY'])) {
      trace.push('Decision agent, because CHANGES or DECIDED_BY');
      found.push(...(await decisionAgent(workspaceId, seeds, edges)));
    }
    if (edges.has('SAID_BY')) {
      trace.push('Chat agent, because SAID_BY');
      found.push(...(await chatAgent(workspaceId, seeds, edges)));
    }
    if (edges.has('PART_OF')) {
      trace.push('File agent, because PART_OF');
      found.push(...(await fileAgent(workspaceId, seeds, edges, terms)));
    }

    const unique = found
      .filter(
        (source, index) =>
          found.findIndex((candidate) => sourceKey(candidate) === sourceKey(source)) === index,
      )
      .slice(0, 24);
    const written = await writeAnswer(workspaceId, question, unique);
    trace.push('Action agent wrote Answer');
    return { answer: written.text, sources: written.sources, trace };
  }
}

export const graphService = new GraphService();
