import { useRef, useState } from 'react';

type SpeechResult = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechResult) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
};

function speechRecognition(): BrowserSpeechRecognition | null {
  const browser = window as Window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return Recognition ? new Recognition() : null;
}

type BrainSource = {
  kind: 'file' | 'chat' | 'member' | 'decision';
  title: string;
  excerpt: string;
  path?: string;
};

type BrainAnswer = {
  answer: string;
  sources: BrainSource[];
  trace: string[];
};

function isBrainAnswer(value: unknown): value is BrainAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'answer' in value &&
    typeof value.answer === 'string' &&
    'sources' in value &&
    Array.isArray(value.sources) &&
    'trace' in value &&
    Array.isArray(value.trace)
  );
}

function appendBytes(pending: Uint8Array, chunk: Uint8Array): Uint8Array {
  const merged = new Uint8Array(pending.length + chunk.length);
  merged.set(pending);
  merged.set(chunk, pending.length);
  return merged;
}

async function playWavStream(
  context: AudioContext,
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  const reader = stream.getReader();
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  let pending = new Uint8Array(0);
  let sampleRate = 44_100;
  let headerRead = false;
  let nextTime = context.currentTime + 0.08;

  const schedule = (pcm: Uint8Array) => {
    const samples = pcm.byteLength / 2;
    if (samples < 1) return;
    const buffer = context.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32_768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(nextTime, context.currentTime);
    source.start(startAt);
    nextTime = startAt + buffer.duration;
  };

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (signal.aborted) break;
    if (value) pending = appendBytes(pending, value);
    if (!headerRead && pending.length >= 44) {
      const header = pending.slice(0, 44);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const rate = view.getUint32(24, true);
      if (rate > 0) sampleRate = rate;
      pending = pending.slice(44);
      headerRead = true;
    }
    const usable = pending.length - (pending.length % 2);
    const ready = usable >= sampleRate * 2 * 0.12;
    if (headerRead && usable > 0 && (ready || done)) {
      schedule(pending.slice(0, usable));
      pending = pending.slice(usable);
    }
    if (done) break;
  }

  if (signal.aborted) return;

  const remaining = Math.max(0, nextTime - context.currentTime);
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, remaining * 1000);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function getErrorMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return 'The workspace brain could not answer that.';
}

const fishVoices = [
  { id: 'd791ee5312e347ba8f362c13988688b5', label: 'Max Verstappen' },
  { id: '65469cc083814bc2ba43ce2292f1dd85', label: 'Lewis Hamilton' },
  { id: '46aeb95b48b04ba9abc0a74e789f3475', label: 'Charles Leclerc' },
];

const prompts = [
  'Who owns this workspace?',
  'Where is the README?',
  'What did the team say in chat?',
  'What did we just find?',
];

export function WorkspaceBrain({
  workspaceId,
  onOpenFile,
  onClose,
}: {
  workspaceId: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [voiceId, setVoiceId] = useState(fishVoices[0]?.id ?? '');
  const [answer, setAnswer] = useState<BrainAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const playback = useRef<AudioContext | null>(null);
  const speechRequest = useRef<AbortController | null>(null);

  function stopSpeaking() {
    speechRequest.current?.abort();
    speechRequest.current = null;
    const context = playback.current;
    playback.current = null;
    void context?.close().catch(() => undefined);
    setIsSpeaking(false);
  }

  async function play(text: string) {
    stopSpeaking();
    const controller = new AbortController();
    speechRequest.current = controller;
    const context = new AudioContext();
    playback.current = context;
    void context.resume();
    setIsSpeaking(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/speech`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          ...(voiceId.trim() ? { voiceId: voiceId.trim() } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        const payload: unknown = await response.json();
        throw new Error(getErrorMessage(payload));
      }
      await playWavStream(context, response.body, controller.signal);
    } catch (speakError) {
      if (controller.signal.aborted) return;
      setError(
        speakError instanceof Error ? speakError.message : 'The answer could not be spoken.',
      );
    } finally {
      if (speechRequest.current === controller) {
        speechRequest.current = null;
        playback.current = null;
        setIsSpeaking(false);
        void context.close().catch(() => undefined);
      }
    }
  }

  async function ask(nextQuestion = question, speakAfter = false) {
    stopSpeaking();
    const trimmed = nextQuestion.trim();
    if (trimmed.length < 2) {
      setError('Ask something a little more specific.');
      return;
    }

    setQuestion(trimmed);
    setIsAsking(true);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/brain`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload: unknown = await response.json();

      if (!response.ok || !isBrainAnswer(payload)) {
        throw new Error(getErrorMessage(payload));
      }

      setAnswer(payload);
      if (speakAfter) {
        await play(payload.answer);
      }
    } catch (askError) {
      setAnswer(null);
      setError(
        askError instanceof Error ? askError.message : 'The workspace brain could not answer that.',
      );
    } finally {
      setIsAsking(false);
    }
  }

  function dictate() {
    const recognition = speechRecognition();
    if (!recognition) {
      setError('This browser cannot take dictation. Type the question instead.');
      return;
    }

    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? '';
      if (transcript) {
        void ask(transcript, true);
      }
    };
    recognition.onerror = () => {
      setIsListening(false);
      setError('Dictation stopped before a question was captured.');
    };
    recognition.onend = () => setIsListening(false);
    setIsListening(true);
    setError(null);
    recognition.start();
  }

  return (
    <aside className="absolute bottom-6 right-0 top-0 z-10 flex w-96 max-w-full flex-col border-l border-[#7a6856] bg-[#4e4338] shadow-2xl">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#7a6856] px-4 text-xs font-semibold uppercase tracking-wide">
        <span>Workspace brain</span>
        <button
          className="text-lg text-[#f5b942] hover:text-white"
          type="button"
          aria-label="Close workspace brain"
          onClick={() => {
            stopSpeaking();
            onClose();
          }}
        >
          ×
        </button>
      </div>
      <div className="border-b border-[#7a6856] px-4 py-3 text-xs leading-5 text-[#f5b942]">
        Searches through agents chosen by the FalkorDB graph. The trace shows which link let each
        agent run.
      </div>
      <form
        className="flex shrink-0 gap-2 border-b border-[#7a6856] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-[#9a846e] bg-[#3a3128] px-2 py-2 text-xs text-[#fff4df] outline-none focus:border-cyan-300"
          value={question}
          placeholder="Ask about a file, a person, or the chat"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          className="rounded border border-[#9a846e] px-2 py-2 text-xs text-[#fff4df] disabled:opacity-50"
          type="button"
          disabled={isAsking || isListening}
          onClick={dictate}
        >
          {isListening ? 'Listening…' : 'Dictate'}
        </button>
        <button
          className="rounded bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={isAsking}
        >
          {isAsking ? 'Looking…' : 'Ask'}
        </button>
      </form>
      <label className="flex shrink-0 items-center gap-2 border-b border-[#7a6856] px-3 py-2 text-[11px] text-[#e2c7a4]">
        Voice
        <select
          className="min-w-0 flex-1 rounded border border-[#9a846e] bg-[#3a3128] px-2 py-1 text-xs text-[#fff4df] outline-none focus:border-cyan-300"
          value={voiceId}
          onChange={(event) => setVoiceId(event.target.value)}
        >
          {fishVoices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex shrink-0 flex-wrap gap-2 px-3 py-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="rounded-full border border-[#9a846e] px-2 py-1 text-[11px] text-[#fff4df] hover:border-cyan-300"
            type="button"
            onClick={() => void ask(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-xs leading-5">
        {error ? (
          <p className="rounded border border-rose-400/40 bg-rose-500/10 p-2 text-rose-200">
            {error}
          </p>
        ) : null}
        {answer ? (
          <>
            <p className="whitespace-pre-wrap text-[#fff4df]">{answer.answer}</p>
            <div className="flex gap-2">
              <button
                className="rounded border border-[#f5b942] px-2 py-1 text-[11px] text-[#ffd56a] disabled:opacity-50"
                type="button"
                disabled={isSpeaking}
                onClick={() => void play(answer.answer)}
              >
                {isSpeaking ? 'Speaking…' : 'Hear it'}
              </button>
              <button
                className="rounded border border-[#9a846e] px-2 py-1 text-[11px] text-[#fff4df] disabled:opacity-40"
                type="button"
                disabled={!isSpeaking}
                onClick={stopSpeaking}
              >
                Stop
              </button>
            </div>
            {answer.trace.length > 0 ? (
              <ol className="space-y-1 rounded border border-[#7a6856] bg-[#3a3128] p-2 text-[11px] text-[#ffd56a]">
                {answer.trace.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            {answer.sources.length > 0 ? (
              <ul className="space-y-2">
                {answer.sources.map((source) => (
                  <li
                    key={`${source.kind}-${source.title}`}
                    className="rounded border border-[#7a6856] bg-[#3a3128] p-2"
                  >
                    <p className="text-[11px] uppercase tracking-[0.16em] text-cyan-300">
                      {source.kind}
                    </p>
                    {source.path ? (
                      <button
                        className="mt-1 text-left font-semibold text-[#ffd56a] hover:underline"
                        type="button"
                        onClick={() => onOpenFile(source.path ?? '')}
                      >
                        {source.title}
                      </button>
                    ) : (
                      <p className="mt-1 font-semibold text-[#fff4df]">{source.title}</p>
                    )}
                    <p className="mt-1 text-[#e2c7a4]">{source.excerpt}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-[#e2c7a4]">
            Try “Who owns this workspace?” or the name of a file you expect to be in the repo.
          </p>
        )}
      </div>
    </aside>
  );
}
