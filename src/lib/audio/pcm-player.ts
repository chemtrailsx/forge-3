'use client';

/**
 * Main-thread handle for the PCM playback worklet.
 *
 * Owns the AudioContext, which is pinned to the provider's sample rate so no
 * resampling sits between the samples we send and the samples we count.
 */

export type PlayerEvents = {
  onPlayingChange?: (playing: boolean) => void;
  onProgress?: (playedByContext: Record<string, number>) => void;
};

export class PcmPlayer {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private pendingClear: (() => void) | null = null;
  private lastProgress: Record<string, number> = {};

  constructor(
    readonly sampleRate: number,
    private readonly events: PlayerEvents = {},
  ) {}

  get audioContext(): AudioContext | null {
    return this.context;
  }

  private drainTimer: number | null = null;

  async init(): Promise<void> {
    if (this.context) return;

    const context = new AudioContext({ sampleRate: this.sampleRate, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/worklets/pcm-player.js');

    const node = new AudioWorkletNode(context, 'pcm-player', {
      outputChannelCount: [1],
      processorOptions: {
        // ~60 ms of cushion before the first syllable for crisp, low-latency start.
        minBufferSamples: Math.round(this.sampleRate * 0.06),
      },
    });
    const gain = context.createGain();
    gain.gain.value = 1;
    node.connect(gain).connect(context.destination);

    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: 'playing' | 'drained' | 'cleared' }
        | { type: 'played'; total: number; byContext: Record<string, number> };

      if (message.type === 'playing') {
        if (this.drainTimer !== null) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }
        this.events.onPlayingChange?.(true);
      } else if (message.type === 'drained') {
        if (this.drainTimer !== null) clearTimeout(this.drainTimer);
        this.drainTimer = window.setTimeout(() => {
          this.drainTimer = null;
          this.events.onPlayingChange?.(false);
        }, 150);
      } else if (message.type === 'cleared') {
        if (this.drainTimer !== null) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }
        const resolve = this.pendingClear;
        this.pendingClear = null;
        resolve?.();
        this.events.onPlayingChange?.(false);
      } else if (message.type === 'played') {
        this.lastProgress = message.byContext;
        this.events.onProgress?.(message.byContext);
      }
    };

    this.context = context;
    this.node = node;
    this.gain = gain;
  }

  /** Browsers suspend an AudioContext created before a user gesture. */
  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  /** @param pcm base64-encoded signed 16-bit little-endian mono PCM. */
  enqueueBase64(contextId: string, pcm: string): void {
    if (!this.node) return;
    const bytes = base64ToBytes(pcm);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      floats[i] = (samples[i] ?? 0) / 32768;
    }
    // Transferred, not copied: audio buffers are large and arrive often.
    this.node.port.postMessage({ type: 'push', contextId, data: floats }, [floats.buffer]);
  }

  /**
   * Barge-in: drop everything queued.
   *
   * Resolves when the audio thread acknowledges, so the caller can measure the
   * real stop latency rather than the time it took to post a message.
   */
  clear(): Promise<void> {
    if (!this.node) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingClear = resolve;
      this.node?.port.postMessage({ type: 'clear' });
      // The worklet only runs while the context is not suspended; never hang
      // the interruption path on an ack that cannot arrive.
      setTimeout(() => {
        if (this.pendingClear === resolve) {
          this.pendingClear = null;
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Tell the player no more audio is coming, so it plays out the remainder.
   *
   * Called when a turn's stream ends. The jitter buffer otherwise holds back
   * anything shorter than its cushion waiting for audio that will never
   * arrive, which drops short trailing clauses entirely.
   */
  flush(): void {
    this.node?.port.postMessage({ type: 'flush' });
  }

  /** Samples rendered per context, as of the last report from the audio thread. */
  progress(): Record<string, number> {
    return this.lastProgress;
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  /** Plays a standalone clip (a backchannel) without disturbing the queue. */
  async playClip(pcm: ArrayBuffer, volume = 0.6): Promise<void> {
    const context = this.context;
    if (!context) return;

    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = (samples[i] ?? 0) / 32768;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    source.start();
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.gain?.disconnect();
    await this.context?.close();
    this.context = null;
    this.node = null;
    this.gain = null;
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
