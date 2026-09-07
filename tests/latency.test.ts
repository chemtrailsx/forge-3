import { describe, expect, it } from 'vitest';
import { runTurn } from '@/lib/voice/orchestrator';
import type { TurnEvent } from '@/lib/voice/events';
import { ALICE, ALICE_SESSION, FakeLlm, FakeTts, makeDb, seedTables } from './helpers/fixtures';

/**
 * How long the cook waits, measured where it is actually spent.
 *
 * The wait before the first syllable is three things: the round trips needed
 * to assemble the prompt, the model writing the first clause, and the speech
 * synthesis of that clause. Only the middle one is thinking. These tests hold
 * the other two down, because they are the ones that quietly grow — a new
 * lookup added to the prologue is a chained round trip nobody notices in
 * development, where the database is a few milliseconds away, and everybody
 * notices in a kitchen.
 */

const signal = () => new AbortController().signal;

/** A round trip slow enough that chaining is unmistakable in the total. */
const RTT = 40;

async function timeTo(
  events: AsyncGenerator<TurnEvent>,
  type: TurnEvent['type'],
): Promise<{ ms: number; events: TurnEvent[] }> {
  const started = Date.now();
  const seen: TurnEvent[] = [];
  let ms = -1;
  for await (const event of events) {
    seen.push(event);
    if (event.type === type && ms < 0) ms = Date.now() - started;
  }
  return { ms, events: seen };
}

describe('the wait before the first word', () => {
  it('opens the speech connection while the database is still being read', async () => {
    const { db } = makeDb(ALICE, seedTables(), RTT);
    const tts = new FakeTts();
    const warmedAt: number[] = [];
    const started = Date.now();
    Object.assign(tts, { warm: () => warmedAt.push(Date.now() - started) });

    await timeTo(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti.' }]),
        tts,
      }),
      'turn.end',
    );

    // Before the reads resolve, not after — on a cold serverless process the
    // handshake is otherwise in front of the first syllable instead of beside
    // work that was happening anyway.
    expect(warmedAt).toHaveLength(1);
    expect(warmedAt[0]).toBeLessThan(RTT);
  });

  it('loads the prompt in one wave of queries, not a chain of them', async () => {
    const { db } = makeDb(ALICE, seedTables(), RTT);

    const { ms } = await timeTo(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti.' }]),
        tts: new FakeTts(),
      }),
      'turn.start',
    );

    /*
     * Two waves are unavoidable: the session has to be read before the recipe
     * it points at can be. Everything else — the turn index, the memory, the
     * profile, the history, the timers — depends on none of it and rides
     * alongside. Six chained trips (240 ms here, ~900 ms against the real
     * database) was the single largest component of the wait.
     */
    expect(ms).toBeLessThan(RTT * 3.5);
  });

  it('does not make the cook wait while their own words are written down', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables, RTT);

    const { ms, events } = await timeTo(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti.' }]),
        tts: new FakeTts(),
      }),
      'assistant.text',
    );

    // The model call and the write of the user's line are independent, so the
    // write must not sit between the prompt and the answer. With the write
    // awaited in front of the model this is a whole round trip longer.
    expect(ms).toBeLessThan(RTT * 3);

    // Still written, and still before the assistant's reply to it: the
    // transcript is read back in turn order and would otherwise interleave
    // wrongly on the next turn.
    const turns = tables.conversation_turns ?? [];
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(events.some((e) => e.type === 'turn.end')).toBe(true);
  });

  it('still repairs an interrupted turn before reading the history back', async () => {
    const tables = seedTables();
    (tables.conversation_turns ??= []).push(
      { id: 'c1', user_id: ALICE, session_id: ALICE_SESSION, turn_index: 0, role: 'user', text: 'how long for the pasta?', heard_text: null, interrupted: false, metrics: {}, created_at: '2026-02-01T10:00:00.000Z' },
      { id: 'c2', user_id: ALICE, session_id: ALICE_SESSION, turn_index: 0, role: 'assistant', text: 'Eight minutes, and then drain it and toss it through the butter.', heard_text: null, interrupted: false, metrics: {}, created_at: '2026-02-01T10:00:01.000Z' },
    );

    const llm = new FakeLlm([{ content: 'Eight minutes.' }]);
    await timeTo(
      runTurn({
        db: makeDb(ALICE, tables).db,
        sessionId: ALICE_SESSION,
        utterance: 'wait, how long?',
        interruption: { turnIndex: 0, heardText: 'Eight minutes, and then', latencyMs: 180 },
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
      'turn.end',
    );

    // The prompt must carry what the cook heard, not the sentence that was cut
    // off. Reading the history concurrently with the repair would race, which
    // is why the interrupted path stays sequential.
    const prompt = JSON.stringify(llm.completeCalls[0]);
    expect(prompt).toContain('Eight minutes, and then');
    expect(prompt).not.toContain('toss it through the butter');
  });
});
