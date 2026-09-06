/**
 * Provider-agnostic TTS contract.
 *
 * The orchestrator is written entirely against this file. Rime is the primary
 * (and currently only) implementation, but nothing above this line knows the
 * word "rime" — swapping the provider means writing one adapter, not editing
 * the voice loop.
 */

export type SpeechProfileName = 'normal' | 'quick' | 'precise';

export type SpeechProfile = {
  name: SpeechProfileName;
  /**
   * Rime `timeScaleFactor`: >1 slower, <1 faster, 1 unchanged (range 0.4–2.5).
   * Honoured on the HTTP transport; ignored over the WebSocket, which is why
   * `transport` travels with it.
   */
  timeScaleFactor: number;
  transport: 'ws' | 'http';
};

export type SpeakRequest = {
  text: string;
  /**
   * Tags every audio chunk with the turn that asked for it, so a chunk that
   * arrives after a barge-in can be discarded by equality rather than by a
   * timing guess.
   */
  contextId: string;
  profile: SpeechProfile;
};

export type TtsAudioChunk = {
  type: 'audio';
  contextId: string;
  seq: number;
  /** Raw PCM (s16le, mono) at the provider's sampling rate. */
  pcm: Buffer;
};

export type TtsTimestamps = {
  type: 'timestamps';
  contextId: string;
  words: string[];
  /** Seconds from the start of this context's audio. */
  start: number[];
  end: number[];
};

export type TtsDone = { type: 'done'; contextId: string };

export type TtsEvent = TtsAudioChunk | TtsTimestamps | TtsDone;

export type TtsDescriptor = {
  provider: string;
  modelId: string;
  voiceId: string;
  lang: string;
  audioFormat: string;
  samplingRate: number;
  transport: string;
  endpoint: string;
};

export interface TtsProvider {
  readonly samplingRate: number;
  descriptor(): TtsDescriptor;
  /**
   * Synthesise `request.text`. The iterable ends when the provider reports the
   * context complete, when `signal` aborts, or on error.
   */
  speak(request: SpeakRequest, signal: AbortSignal): AsyncIterable<TtsEvent>;
  /**
   * Cancel synthesis the provider has accepted but not yet emitted. Must be
   * safe to call from an abort handler: synchronous, non-throwing, and
   * idempotent.
   */
  cancel(): void;
  close(): void;
}
