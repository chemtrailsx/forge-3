import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The PCM player runs on the audio thread, as plain JavaScript the bundler
 * never sees and TypeScript never checks. A mistake in it is invisible until
 * an AudioContext refuses to load the module at runtime, by which point the
 * only symptom is silence.
 *
 * So it is loaded here into a stubbed worklet global scope and driven a
 * quantum at a time, exactly as the audio thread would.
 */

const SAMPLE_RATE = 24000;
/** ~180 ms, matching what lib/audio/pcm-player.ts passes in. */
const MIN_BUFFER = Math.round(SAMPLE_RATE * 0.18);

type Processor = {
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  port: { onmessage: (event: { data: unknown }) => void };
};

let PcmPlayer: new (options: { processorOptions: { minBufferSamples: number } }) => Processor;

beforeAll(() => {
  const registered: Record<string, unknown> = {};
  const context = createContext({
    AudioWorkletProcessor: class {
      port = { postMessage: () => undefined, onmessage: (_event: { data: unknown }) => undefined };
    },
    registerProcessor: (name: string, cls: unknown) => {
      registered[name] = cls;
    },
    sampleRate: SAMPLE_RATE,
    console,
  });

  const source = readFileSync(
    resolve(__dirname, '../public/worklets/pcm-player.js'),
    'utf8',
  );
  runInContext(source, context, { filename: 'pcm-player.js' });

  PcmPlayer = registered['pcm-player'] as typeof PcmPlayer;
});

function harness() {
  const player = new PcmPlayer({ processorOptions: { minBufferSamples: MIN_BUFFER } });
  const output = [new Float32Array(128)];

  return {
    push(samples: number, contextId = 'c1') {
      player.port.onmessage({
        data: { type: 'push', contextId, data: new Float32Array(samples).fill(0.5) },
      });
    },
    clear() {
      player.port.onmessage({ data: { type: 'clear' } });
    },
    flush() {
      player.port.onmessage({ data: { type: 'flush' } });
    },
    /** Renders one quantum; true if any audio came out. */
    quantum(): boolean {
      const channel = output[0]!;
      channel.fill(0);
      // `outputs` is a list of outputs, each a list of channels — so one mono
      // output is [[channel]], not [channel].
      player.process([], [output]);
      return channel.some((value) => value !== 0);
    },
  };
}

describe('the module loads at all', () => {
  it('registers the processor the AudioContext asks for', () => {
    expect(PcmPlayer).toBeTypeOf('function');
  });
});

describe('jitter buffer', () => {
  /**
   * Chunks arrive over the network without pacing themselves to the speaker.
   * Playing the instant the first one lands means the queue runs dry whenever
   * one is late, and every dry quantum is a hole punched in a word — which is
   * what "the voice glitches in between" sounded like.
   */
  it('stays silent until there is a cushion', () => {
    const player = harness();
    expect(player.quantum()).toBe(false);

    player.push(1000);
    expect(player.quantum()).toBe(false);
  });

  it('plays once enough is buffered', () => {
    const player = harness();
    player.push(MIN_BUFFER + 500);
    expect(player.quantum()).toBe(true);
  });

  it('plays continuously through a whole utterance', () => {
    const player = harness();
    player.push(MIN_BUFFER * 2);

    // Every quantum inside the buffered audio must produce sound; a single
    // silent one mid-word is the artefact being prevented.
    for (let i = 0; i < 20; i += 1) {
      expect(player.quantum(), `quantum ${i}`).toBe(true);
    }
  });

  it('re-primes after running dry instead of trickling out late chunks', () => {
    const player = harness();
    player.push(MIN_BUFFER + 500);
    while (player.quantum()) {
      /* drain */
    }

    // One small late chunk must not restart playback, or the rest of the
    // sentence stutters chunk by chunk.
    player.push(600);
    expect(player.quantum()).toBe(false);

    player.push(MIN_BUFFER);
    expect(player.quantum()).toBe(true);
  });

  /**
   * Reported from a real session: "it stopped narrating one response midway".
   *
   * A trailing clause shorter than the cushion — "Got it." — waits for audio
   * that will never arrive, and is dropped in silence. The end of a turn has
   * to tell the player that nothing more is coming.
   */
  it('drops a short trailing clause without a flush — the reported bug', () => {
    const player = harness();
    player.push(MIN_BUFFER * 2);
    while (player.quantum()) {
      /* play the long clause out */
    }

    player.push(Math.round(MIN_BUFFER / 2)); // ~90 ms, under the cushion
    let heard = false;
    for (let i = 0; i < 200; i += 1) heard = player.quantum() || heard;
    expect(heard).toBe(false);
  });

  it('plays that clause once told no more audio is coming', () => {
    const player = harness();
    player.push(MIN_BUFFER * 2);
    while (player.quantum()) {
      /* play the long clause out */
    }

    player.push(Math.round(MIN_BUFFER / 2));
    player.flush();
    expect(player.quantum()).toBe(true);
  });

  it('re-arms the cushion for the next turn after a flush drains', () => {
    const player = harness();
    player.push(1000);
    player.flush();
    while (player.quantum()) {
      /* drain */
    }

    // The next burst still gets the benefit of the jitter buffer.
    player.push(500);
    expect(player.quantum()).toBe(false);
  });

  it('drops everything on clear, which is what barge-in depends on', () => {
    const player = harness();
    player.push(MIN_BUFFER * 3);
    expect(player.quantum()).toBe(true);

    player.clear();
    expect(player.quantum()).toBe(false);
  });
});
