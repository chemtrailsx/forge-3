import { sttEnv, type SttEnv } from '../env';
import { ProviderError, ValidationError } from '../errors';
import { isLikelyHallucination } from './hallucinations';
import { RECOGNITION_FRAMING, buildRecognitionPrompt } from './vocabulary';

/**
 * Speech to text, against an OpenAI-compatible `/audio/transcriptions`
 * endpoint (Whisper by default).
 *
 * Runs server-side so the STT key never reaches the browser, and so the same
 * request can be replaced by a different provider through env alone.
 */

export interface SttProvider {
  readonly model: string;
  /**
   * @param hint words from the live conversation to bias recognition towards.
   *        Empty is valid and gives the standing vocabulary alone.
   */
  transcribe(audio: Blob, signal: AbortSignal, hint?: string): Promise<string>;
}

/** 25 MB is the common provider ceiling; an utterance is orders below it. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class OpenAiCompatibleStt implements SttProvider {
  constructor(private readonly config: SttEnv) {}

  get model(): string {
    return this.config.model;
  }

  async transcribe(audio: Blob, signal: AbortSignal, hint?: string): Promise<string> {
    if (audio.size === 0) throw new ValidationError('Empty audio upload.');
    if (audio.size > MAX_AUDIO_BYTES) throw new ValidationError('Audio clip is too large.');

    const prompt = buildRecognitionPrompt({ spoken: hint });

    const form = new FormData();
    form.append('file', audio, fileNameFor(audio.type));
    form.append('model', this.config.model);
    form.append('response_format', 'json');
    // Biases decoding towards the words this kitchen is actually using. See
    // `vocabulary.ts` for why the live conversation goes in ahead of the
    // standing list.
    form.append('prompt', prompt);
    /*
     * Pinned rather than detected. Left to guess, the model can decide a few
     * seconds of accented English with Hindi dish names in it are another
     * language altogether, and transliterate the lot.
     */
    form.append('language', 'en');
    /*
     * No sampling. Temperature is what turns an unfamiliar word into a
     * confident, plausible, wrong one — "tandoori" into "durin" — and there is
     * no upside to invention in a transcript.
     */
    form.append('temperature', '0');

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

    /*
     * Whisper answers silence with speech. Returning an empty string here
     * means the caller treats it as "nothing was said", which is the truth.
     *
     * Only the framing sentence is offered as the echo to look for, never the
     * vocabulary: a short transcript made entirely of vocabulary words is not
     * an artefact, it is a cook saying "lamb korma and tandoori naan", and
     * discarding that would defeat the point of having primed for it.
     */
    if (isLikelyHallucination(text, RECOGNITION_FRAMING)) {
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
