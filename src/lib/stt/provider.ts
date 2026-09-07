import { sttEnv, type SttEnv } from '../env';
import { ProviderError, ValidationError } from '../errors';
import { isLikelyHallucination } from './hallucinations';

/**
 * Speech to text, against an OpenAI-compatible `/audio/transcriptions`
 * endpoint (Whisper by default).
 *
 * Runs server-side so the STT key never reaches the browser, and so the same
 * request can be replaced by a different provider through env alone.
 */

export interface SttProvider {
  readonly model: string;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
}

/**
 * Recognition hint. Kept short: every word in it is a word the model may hand
 * back verbatim when there is nothing to transcribe.
 */
const DOMAIN_PROMPT =
  'Cooking conversation. Ingredients, quantities, grams, millilitres, teaspoons, tablespoons, timers, oven temperatures.';

/** 25 MB is the common provider ceiling; an utterance is orders below it. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class OpenAiCompatibleStt implements SttProvider {
  constructor(private readonly config: SttEnv) {}

  get model(): string {
    return this.config.model;
  }

  async transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
    if (audio.size === 0) throw new ValidationError('Empty audio upload.');
    if (audio.size > MAX_AUDIO_BYTES) throw new ValidationError('Audio clip is too large.');

    const form = new FormData();
    form.append('file', audio, fileNameFor(audio.type));
    form.append('model', this.config.model);
    form.append('response_format', 'json');
    // A domain hint improves recognition of ingredient names and fractional
    // quantities, which is most of what gets said here. It is also what the
    // model reads back when handed silence, so the same text is passed to the
    // filter below to be recognised on the way out.
    form.append('prompt', DOMAIN_PROMPT);

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        'stt',
        response.status === 429
          ? 'Speech recognition is rate limited right now.'
          : `Speech recognition failed (${response.status}). ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as { text?: string };
    const text = (payload.text ?? '').trim();

    // Whisper answers silence with speech. Returning an empty string here
    // means the caller treats it as "nothing was said", which is the truth.
    if (isLikelyHallucination(text, DOMAIN_PROMPT)) {
      console.warn(`[stt] discarded a likely silence artefact: ${JSON.stringify(text)}`);
      return '';
    }

    return text;
  }
}

function fileNameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'utterance.webm';
  if (mimeType.includes('ogg')) return 'utterance.ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'utterance.mp4';
  if (mimeType.includes('wav')) return 'utterance.wav';
  return 'utterance.webm';
}

export function getSttProvider(): SttProvider {
  return new OpenAiCompatibleStt(sttEnv());
}
