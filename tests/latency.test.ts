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

async function drain(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const seen: TurnEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('the wait before the first word', () => {
  it('opens the speech connection while the database is still being read', async () => {
    const { db } = makeDb(ALICE, seedTables(), RTT);
    const tts = new FakeTts();
    const warmedAt: number[] = [];
    const started = Date.now();
    Object.assign(tts, { warm: () => warmedAt.push(Date.now() - started) });

    await drain(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti.' }]),
        tts,
      }),
    );

    // Before the reads resolve, not after — on a cold serverless process the
    // handshake is otherwise in front of the first syllable instead of beside
    // work that was happening anyway.
    expect(warmedAt).toHaveLength(1);
    expect(warmedAt[0]).toBeLessThan(RTT);
  });

  it('loads the prompt in one wave of queries, not a chain of them', async () => {
    const { db, fake } = makeDb(ALICE, seedTables(), RTT);

    await drain(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti.' }]),
        tts: new FakeTts(),
      }),
    );

    /*
     * Measured as concurrency rather than elapsed time. A prologue that awaits
     * its reads one after another never gets above one query in flight however
     * fast the machine is, and one that batches them reaches four — while a
     * stopwatch assertion only reports which of those happened when the suite
     * happens to be idle.
     *
     * Four: the turn index, the memory, the profile and the history all go out
     * together with the session read. Only the recipe has to wait, because it
     * is the session that says which recipe to fetch. Six chained trips was
     * roughly 900 ms against the real database, and the single largest
     * component of the wait before the cook heard anything.
     */
    expect(fake.maxConcurrent).toBeGreaterThanOrEqual(4);
  });

  it('does not make the cook wait while their own words are written down', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables, RTT);

    /*
     * The model is asked while the write of the user's line is still in the
     * air. Nothing in the prompt depends on that row existing, so awaiting it
     * put a whole round trip between the cook finishing their sentence and the
     * model starting to answer.
     */
    let writeInFlightWhenAsked = false;
    const llm = new FakeLlm([{ content: 'Add the spaghetti.' }]);
    const watched = {
      ...llm,
      model: llm.model,
      complete: llm.complete.bind(llm),
      stream: llm.stream.bind(llm),
      streamWithTools(...args: Parameters<typeof llm.streamWithTools>) {
        writeInFlightWhenAsked = (tables.conversation_turns ?? []).length === 0;
        return llm.streamWithTools(...args);
      },
    };

    const events = await drain(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: watched,
        tts: new FakeTts(),
      }),
    );

    expect(writeInFlightWhenAsked).toBe(true);

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
    await drain(
      runTurn({
        db: makeDb(ALICE, tables).db,
        sessionId: ALICE_SESSION,
        utterance: 'wait, how long?',
        interruption: { turnIndex: 0, heardText: 'Eight minutes, and then', latencyMs: 180 },
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
    );

    // The prompt must carry what the cook heard, not the sentence that was cut
    // off. Reading the history concurrently with the repair would race, which
    // is why the interrupted path stays sequential.
    const prompt = JSON.stringify(llm.completeCalls[0]);
    expect(prompt).toContain('Eight minutes, and then');
    expect(prompt).not.toContain('toss it through the butter');
  });
});
