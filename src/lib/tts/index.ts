import { getRimeAdapter } from './rime/adapter';
import type { TtsProvider } from './types';

/**
 * The single seam between the voice loop and a TTS vendor.
 *
 * Rime is the primary spoken-output layer for this product; if another provider
 * is ever added, it implements `TtsProvider` and is selected here. Nothing
 * upstream changes.
 */
export function getTtsProvider(): TtsProvider {
  return getRimeAdapter();
}

export * from './types';
export { selectProfile, PROFILES } from './speech-profile';
export { toSpeakable, toSpeakableExplained, segmentForSpeech } from './speakable';
