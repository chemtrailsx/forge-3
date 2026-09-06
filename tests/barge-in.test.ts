import { describe, expect, it } from 'vitest';
import { runTurn } from '@/lib/voice/orchestrator';
import { concatTimelines, wordsHeard } from '@/lib/voice/heard-ledger';
import { HeardTracker } from '@/lib/voice/heard-tracker';
import type { TurnEvent } from '@/lib/voice/events';
import { ALICE, ALICE_SESSION, FakeLlm, FakeTts, makeDb, seedTables } from './helpers/fixtures';

/**
 * Barge-in is the hero engineering feature, so it is tested at both levels:
 * the ledger arithmetic that decides what was heard, and the orchestrator
 * behaviour when a turn is cancelled mid-sentence.
 */

describe('heard ledger', () => {
  const timeline = {
    words: ['Drain', 'the', 'pasta', 'and', 'add', 'the', 'butter.'],
    start: [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8],
    end: [0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1],
  };

  it('counts only words whose audio finished playing', () => {
    const result = wordsHeard(timeline, 1.2);
    expect(result.heardText).toBe('Drain the pasta and');
    expect(result.complete).toBe(false);
  });

  it('does not count a word that was cut halfway through', () => {
    // 1.35 s lands in the middle of "add" — half a word is not information.
    expect(wordsHeard(timeline, 1.35).heardText).toBe('Drain the pasta and');
  });

  it('reports a complete utterance when everything played', () => {
    const result = wordsHeard(timeline, 5);
    expect(result.complete).toBe(true);
    expect(result.heardWordCount).toBe(7);
  });

  it('reports nothing heard when playback never started', () => {
    expect(wordsHeard(timeline, 0).heardText).toBe('');
  });

  it('merges per-clause timelines into one utterance', () => {
    const merged = concatTimelines([
      { words: ['one', 'two'], start: [0, 0.5], end: [0.5, 1] },
      { words: ['three'], start: [0], end: [0.5] },
    ]);
    expect(merged.words).toEqual(['one', 'two', 'three']);
    expect(merged.start[2]).toBe(1);
    expect(merged.end[2]).toBe(1.5);
  });
});

describe('browser-side tracker', () => {
  const sampleRate = 24000;

  it('cuts at the right clause when a later one never played', () => {
    const tracker = new HeardTracker(sampleRate);
    tracker.beginSegment('c1', 'Drain the pasta.');
    tracker.addTimeline('c1', { words: ['Drain', 'the', 'pasta.'], start: [0, 0.3, 0.6], end: [0.3, 0.6, 0.9] });
    tracker.beginSegment('c2', 'Then add the butter.');
    tracker.addTimeline('c2', {
      words: ['Then', 'add', 'the', 'butter.'],
      start: [0, 0.3, 0.6, 0.9],
      end: [0.3, 0.6, 0.9, 1.2],
    });

    // The first clause played fully; the second never started.
    const heard = tracker.heardText({ c1: Math.round(0.9 * sampleRate) });
    expect(heard).toBe('Drain the pasta.');
  });

  it('falls back to a proportional estimate when the transport gave no timings', () => {
    const tracker = new HeardTracker(sampleRate);
    tracker.beginSegment('c1', 'one two three four');
    tracker.addSamples('c1', 4000);

    expect(tracker.heardText({ c1: 2000 })).toBe('one two');
  });

  it('reports nothing when audio never reached the speaker', () => {
    const tracker = new HeardTracker(sampleRate);
    tracker.beginSegment('c1', 'Drain the pasta.');
    tracker.addTimeline('c1', { words: ['Drain'], start: [0], end: [0.3] });
    expect(tracker.heardText({})).toBe('');
  });
});

describe('orchestrator under interruption', () => {
  const collect = async (
    events: AsyncGenerator<TurnEvent>,
    onEvent?: (event: TurnEvent) => void | Promise<void>,
  ): Promise<TurnEvent[]> => {
    const out: TurnEvent[] = [];
    for await (const event of events) {
      out.push(event);
      await onEvent?.(event);
    }
    return out;
  };

  it('emits no further audio once the request is aborted', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);
    const controller = new AbortController();
    // A slow TTS, so there is something in flight to cancel.
    const tts = new FakeTts(20, 8);
    const llm = new FakeLlm([{ content: 'Drain the pasta and add the butter. Then serve it hot.' }]);

    let audioSeen = 0;
    let abortedAt = -1;

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what next?',
        signal: controller.signal,
        llm,
        tts,
      }),
      (event) => {
        if (event.type === 'audio') {
          audioSeen += 1;
          if (audioSeen === 2) {
            abortedAt = audioSeen;
            controller.abort();
          }
        }
      },
    );

    const audioEvents = events.filter((event) => event.type === 'audio');
    expect(abortedAt).toBe(2);
    // One more chunk may already have been in flight; nothing beyond that.
    expect(audioEvents.length).toBeLessThanOrEqual(3);
    expect(events.some((event) => event.type === 'turn.end')).toBe(false);
    expect(tts.cancelled).toBeGreaterThan(0);
  });

  it('records the interrupted turn so the next one can rewrite it', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);
    const controller = new AbortController();

    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what next?',
        signal: controller.signal,
        llm: new FakeLlm([{ content: 'Drain the pasta and add the butter.' }]),
        tts: new FakeTts(20, 8),
      }),
      (event) => {
        if (event.type === 'audio') controller.abort();
      },
    );

    const assistantTurn = tables.conversation_turns?.find((row) => row.role === 'assistant');
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn?.interrupted).toBe(true);
    // heard_text stays null until the browser reports the real cut point;
    // guessing it server-side would be worse than admitting we do not know.
    expect(assistantTurn?.heard_text).toBeNull();
  });

  it('rewrites history to the heard half and treats the correction as context', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    // Turn one, cut off.
    const first = new AbortController();
    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what next?',
        signal: first.signal,
        llm: new FakeLlm([{ content: 'Drain the pasta and add the butter.' }]),
        tts: new FakeTts(20, 8),
      }),
      (event) => {
        if (event.type === 'audio') first.abort();
      },
    );

    const interruptedTurn = tables.conversation_turns?.find((row) => row.role === 'assistant');
    const turnIndex = Number(interruptedTurn?.turn_index ?? 0);

    // Turn two: the correction, carrying what was actually heard.
    const llm = new FakeLlm([{ content: 'Right. Add the salt first.' }]);
    const second = new AbortController();
    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: "Wait, I haven't added the salt.",
        interruption: { turnIndex, heardText: 'Drain the pasta and', latencyMs: 42 },
        signal: second.signal,
        llm,
        tts: new FakeTts(),
      }),
    );

    const rewritten = tables.conversation_turns?.find(
      (row) => row.role === 'assistant' && row.turn_index === turnIndex,
    );
    expect(rewritten?.heard_text).toBe('Drain the pasta and');
    expect(rewritten?.interrupted).toBe(true);

    // The correction becomes part of the cooking state...
    const session = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect((session?.notes as { corrections?: string[] }).corrections).toContain(
      "Wait, I haven't added the salt.",
    );

    // ...and the prompt for the new turn must not replay the unheard words.
    const prompt = JSON.stringify(llm.completeCalls[0]);
    expect(prompt).toContain('Drain the pasta and');
    expect(prompt).not.toContain('add the butter');
    expect(events.some((event) => event.type === 'turn.end')).toBe(true);
  });

  it('cancels a slow tool rather than letting its result be spoken later', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);
    const controller = new AbortController();

    const llm = new FakeLlm(
      [
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'scale_recipe', arguments: JSON.stringify({ servings: 6 }) }],
        },
      ],
      'You will need six hundred grams.',
    );

    process.env.TOOL_DELAY_MS = '400';
    try {
      const events = await collect(
        runTurn({
          db,
          sessionId: ALICE_SESSION,
          utterance: 'scale it to six',
          signal: controller.signal,
          llm,
          tts: new FakeTts(),
        }),
        (event) => {
          // Interrupt while the tool is still running.
          if (event.type === 'filler') controller.abort();
        },
      );

      expect(events.some((event) => event.type === 'tool.end')).toBe(false);
      expect(events.some((event) => event.type === 'turn.end')).toBe(false);
      // The stream that would have spoken the result never ran.
      expect(llm.streamCalls).toHaveLength(0);
    } finally {
      process.env.TOOL_DELAY_MS = '0';
    }
  });
});
