import { rimeEnv, type RimeEnv } from '../../env';
import { ProviderError } from '../../errors';
import type {
  SpeakRequest,
  TtsDescriptor,
  TtsEvent,
  TtsProvider,
} from '../types';
import { synthesizeHttp } from './http-client';
import { RimeWs3Client, type Ws3AudioChunk, type Ws3Timestamps } from './ws3-client';

/**
 * The Rime implementation of `TtsProvider` — the only file in the system that
 * knows Rime's wire format.
 *
 * Transport is chosen by the speech profile, not by the caller:
 *   ws   → streaming explanations, cancellable at the source (`operation:clear`)
 *   http → short utterances that need `timeScaleFactor`, which ws3 ignores
 *
 * Both transports emit the same `TtsEvent` stream, so the orchestrator does not
 * branch on it.
 */
export class RimeAdapter implements TtsProvider {
  private readonly ws: RimeWs3Client;

  constructor(private readonly config: RimeEnv) {
    if (!config.apiKey) {
      throw new ProviderError('rime', 'RIME_API_KEY is not configured.', 503);
    }
    this.ws = new RimeWs3Client(config);
  }

  get samplingRate(): number {
    return this.config.samplingRate;
  }

  descriptor(): TtsDescriptor {
    return {
      provider: 'rime',
      modelId: this.config.modelId,
      voiceId: this.config.voiceId,
      lang: this.config.lang,
      audioFormat: this.config.audioFormat,
      samplingRate: this.config.samplingRate,
      transport: 'ws3 (streaming) + https (timeScaleFactor)',
      endpoint: this.config.wsEndpoint,
    };
  }

  speak(request: SpeakRequest, signal: AbortSignal): AsyncIterable<TtsEvent> {
    return request.profile.transport === 'http'
      ? this.speakHttp(request, signal)
      : this.speakWs(request, signal);
  }

  /** Cancel at the source. Safe to call from an abort handler. */
  cancel(): void {
    this.ws.clear();
  }

  close(): void {
    this.ws.close();
  }

  private async *speakHttp(request: SpeakRequest, signal: AbortSignal): AsyncIterable<TtsEvent> {
    const pcm = await synthesizeHttp(
      this.config,
      request.text,
      request.profile.timeScaleFactor,
      signal,
    );
    if (signal.aborted) return;

    // Chunked on the way out so the browser can start playing (and can stop
    // part-way through) exactly as it does on the streaming path.
    const chunkBytes = this.config.samplingRate * 2 * 0.2; // ~200 ms of s16le mono
    let seq = 0;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      if (signal.aborted) return;
      yield {
        type: 'audio',
        contextId: request.contextId,
        seq: seq++,
        pcm: pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)),
      };
    }
    yield { type: 'done', contextId: request.contextId };
  }

  /**
   * Start connecting, and do not wait for it.
   *
   * `connect()` is idempotent and returns the in-flight attempt, so the
   * `speak` that follows shares this handshake rather than starting a second
   * one. A failure here is not reported: the connection is retried by `speak`,
   * which is where an error has somewhere to go.
   */
  warm(): void {
    void this.ws.connect().catch(() => {
      // Reported by the speak that needs it.
    });
  }

  private async *speakWs(request: SpeakRequest, signal: AbortSignal): AsyncIterable<TtsEvent> {
    await this.ws.connect();

    const queue: TtsEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;
    let seq = 0;

    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };

    // Every handler filters on contextId. A chunk belonging to a superseded
    // turn is dropped here and can never reach the browser.
    const onAudio = (chunk: Ws3AudioChunk) => {
      if (chunk.contextId !== request.contextId) return;
      queue.push({ type: 'audio', contextId: request.contextId, seq: seq++, pcm: chunk.pcm });
      wake();
    };
    const onTimestamps = (stamps: Ws3Timestamps) => {
      if (stamps.contextId !== request.contextId) return;
      queue.push({
        type: 'timestamps',
        contextId: request.contextId,
        words: stamps.words,
        start: stamps.start,
        end: stamps.end,
      });
      wake();
    };
    const onDone = (contextId: string | null) => {
      if (contextId !== request.contextId) return;
      finished = true;
      wake();
    };
    const onError = (error: Error) => {
      failure = error;
      finished = true;
      wake();
    };
    const onAbort = () => {
      // Cancel what Rime has accepted but not emitted, then end the iterator.
      this.ws.clear();
      finished = true;
      wake();
    };

    this.ws.on('audio', onAudio);
    this.ws.on('timestamps', onTimestamps);
    this.ws.on('done', onDone);
    this.ws.on('rime-error', onError);
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.ws.send(request.text, request.contextId);
      this.ws.flush();

      while (true) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
        }
        if (failure) throw failure;
        if (finished || signal.aborted) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }

      if (!signal.aborted && !failure) {
        yield { type: 'done', contextId: request.contextId };
      }
    } finally {
      this.ws.off('audio', onAudio);
      this.ws.off('timestamps', onTimestamps);
      this.ws.off('done', onDone);
      this.ws.off('rime-error', onError);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * One warm adapter per server process.
 *
 * Kept on `globalThis` so Next's dev-mode module reloading does not leak a new
 * WebSocket on every edit.
 */
const globalForRime = globalThis as unknown as { __rimeAdapter?: RimeAdapter };

export function getRimeAdapter(): RimeAdapter {
  if (!globalForRime.__rimeAdapter) {
    globalForRime.__rimeAdapter = new RimeAdapter(rimeEnv());
  }
  return globalForRime.__rimeAdapter;
}
