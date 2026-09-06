import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RimeEnv } from '../../env';

/**
 * Rime ws3 — the JSON WebSocket API.
 *
 * ws3 rather than the HTTP endpoint for the streaming path, because three of
 * its primitives are load-bearing for barge-in:
 *
 *   `{"operation":"clear"}`  cancels synthesis Rime has accepted but not yet
 *                            emitted, so an interruption is authoritative at
 *                            the source instead of only muted locally.
 *   `contextId` on chunks    turns "is this audio stale?" into an equality
 *                            check against the live turn, not a timing race.
 *   `type: "timestamps"`     gives word-level timing, which is how we compute
 *                            which words actually reached the speaker.
 *
 * The socket is opened once per server process and kept warm; opening it per
 * turn would put a TCP + TLS + auth handshake in front of every first syllable.
 */

export type Ws3AudioChunk = { contextId: string | null; pcm: Buffer };
export type Ws3Timestamps = {
  contextId: string | null;
  words: string[];
  start: number[];
  end: number[];
};

type Frame =
  | { type: 'chunk'; data: string; contextId?: string }
  | { type: 'timestamps'; contextId?: string; word_timestamps?: { words?: string[]; start?: number[]; end?: number[] } }
  | { type: 'done'; contextId?: string }
  | { type: 'error'; message?: string };

export class RimeWs3Client extends EventEmitter {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly config: RimeEnv) {
    super();
    // The orchestrator attaches and detaches per turn; the warm socket outlives
    // all of them, so the default listener cap would trip on a long session.
    this.setMaxListeners(50);
  }

  get url(): string {
    const params = new URLSearchParams({
      speaker: this.config.voiceId,
      modelId: this.config.modelId,
      audioFormat: this.config.audioFormat,
      lang: this.config.lang,
      samplingRate: String(this.config.samplingRate),
      segment: this.config.segment,
    });
    return `${this.config.wsEndpoint}?${params.toString()}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      this.ws = socket;

      const settleFailure = (error: Error) => {
        this.connecting = null;
        this.ws = null;
        reject(error);
      };

      socket.once('open', () => {
        this.connecting = null;
        this.emit('open');
        resolve();
      });
      socket.once('error', settleFailure);
      socket.on('message', (raw: WebSocket.RawData) => this.handleFrame(raw));
      socket.on('close', () => {
        this.ws = null;
        this.emit('close');
      });
    });

    return this.connecting;
  }

  private handleFrame(raw: WebSocket.RawData): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw.toString()) as Frame;
    } catch {
      this.emit('rime-error', new Error('rime: non-JSON frame'));
      return;
    }

    switch (frame.type) {
      case 'chunk':
        this.emit('audio', {
          contextId: frame.contextId ?? null,
          pcm: Buffer.from(frame.data, 'base64'),
        } satisfies Ws3AudioChunk);
        break;
      case 'timestamps': {
        const t = frame.word_timestamps ?? {};
        this.emit('timestamps', {
          contextId: frame.contextId ?? null,
          words: t.words ?? [],
          start: t.start ?? [],
          end: t.end ?? [],
        } satisfies Ws3Timestamps);
        break;
      }
      case 'done':
        this.emit('done', frame.contextId ?? null);
        break;
      case 'error':
        this.emit('rime-error', new Error(`rime: ${frame.message ?? 'unknown error'}`));
        break;
      default:
        break;
    }
  }

  async send(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;
    await this.connect();
    this.ws?.send(JSON.stringify({ text, contextId }));
  }

  /** Ask Rime to emit whatever it is holding rather than waiting for more text. */
  flush(): void {
    if (this.connected) this.ws?.send(JSON.stringify({ operation: 'flush' }));
  }

  /**
   * Authoritative barge-in. Fire-and-forget by design: we must not wait on a
   * network round trip before telling the browser to go silent.
   */
  clear(): void {
    if (!this.connected) return;
    try {
      this.ws?.send(JSON.stringify({ operation: 'clear' }));
    } catch {
      // A socket that died mid-turn is already silent.
    }
  }

  close(): void {
    this.disposed = true;
    if (this.connected) {
      try {
        this.ws?.send(JSON.stringify({ operation: 'eos' }));
      } catch {
        // Already gone.
      }
    }
    this.ws?.close();
    this.ws = null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
