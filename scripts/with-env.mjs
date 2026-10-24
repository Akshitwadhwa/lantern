import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
const env = { ...process.env };

for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    continue;
  }

  const separator = trimmed.indexOf('=');
  if (separator === -1) {
    continue;
  }

  const key = trimmed.slice(0, separator);
  let value = trimmed.slice(separator + 1);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  env[key] = value;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-env.mjs <command> [args]');
  process.exit(1);
}

const child = spawn(command, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
