import { HttpError } from '../errors/httpError.js';

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const MAX_SPOKEN_CHARS = 3_500;

function fishConfig(): { apiKey: string; model: string; voiceId: string } {
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new HttpError(
      503,
      'Fish Audio is not configured. Add FISH_AUDIO_API_KEY to the server environment.',
    );
  }

  return {
    apiKey,
    model: process.env.FISH_AUDIO_MODEL?.trim() || 's2.1-pro-free',
    voiceId: process.env.FISH_AUDIO_VOICE_ID?.trim() ?? '',
  };
}

export async function openSpeech(text: string, voiceId?: string): Promise<ReadableStream<Uint8Array>> {
  const config = fishConfig();
  const referenceId = voiceId?.trim() || config.voiceId;
  const spoken = text.trim().slice(0, MAX_SPOKEN_CHARS);
  const body: { text: string; format: 'wav'; latency: 'low'; reference_id?: string } = {
    text: spoken,
    format: 'wav',
    latency: 'low',
  };
  if (referenceId) {
    body.reference_id = referenceId;
  }

  let response: Response;
  try {
    response = await fetch(FISH_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        model: config.model,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'Fish Audio could not be reached.');
  }

  if (!response.ok || !response.body) {
    throw new HttpError(502, 'Fish Audio could not speak that answer.');
  }

  return response.body;
}
