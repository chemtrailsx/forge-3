import { describe, expect, it } from 'vitest';
import { runTurn } from '@/lib/voice/orchestrator';
import type { TurnEvent } from '@/lib/voice/events';
import { describeState } from '@/lib/llm/prompt';
import { loadCookingState } from '@/lib/cooking/state';
import {
  ALICE,
  ALICE_SESSION,
  BOB,
  BOB_SESSION,
  FakeLlm,
  FakeTts,
  makeDb,
  seedTables,
  toolCall,
} from './helpers/fixtures';

async function collect(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const signal = () => new AbortController().signal;

describe('a normal turn', () => {
  it('answers from state, speaks it, and records both sides of the conversation', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);
    const tts = new FakeTts();

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what am I doing now?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Add the spaghetti and cook it for eight minutes.' }]),
        tts,
      }),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain('turn.start');
    expect(types).toContain('state');
    expect(types).toContain('assistant.text');
    expect(types).toContain('audio');
    expect(types).toContain('turn.end');

    expect(tts.spoken).toHaveLength(1);

    const roles = (tables.conversation_turns ?? []).map((row) => row.role);
    expect(roles).toEqual(['user', 'assistant']);
    const assistant = tables.conversation_turns?.find((row) => row.role === 'assistant');
    expect(assistant?.interrupted).toBe(false);
    expect(assistant?.text).toContain('eight minutes');
  });

  it('reports latency for the turn', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what next?',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Boil the water.' }]),
        tts: new FakeTts(),
      }),
    );

    const end = events.find((event) => event.type === 'turn.end');
    expect(end?.type === 'turn.end' ? end.metrics.timeToFirstAudioMs : null).not.toBeNull();
    expect(end?.type === 'turn.end' ? end.metrics.totalMs : -1).toBeGreaterThanOrEqual(0);
  });

  it('refuses to run against a session belonging to someone else', async () => {
    const { db } = makeDb(ALICE, seedTables());
    await expect(
      collect(
        runTurn({
          db,
          sessionId: BOB_SESSION,
          utterance: 'what next?',
          signal: signal(),
          llm: new FakeLlm([{ content: 'nope' }]),
          tts: new FakeTts(),
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects an empty utterance instead of calling the model', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const llm = new FakeLlm([{ content: 'should not happen' }]);

    const events = await collect(
      runTurn({ db, sessionId: ALICE_SESSION, utterance: '   ', signal: signal(), llm, tts: new FakeTts() }),
    );

    expect(events).toEqual([{ type: 'error', message: 'Nothing was said.' }]);
    expect(llm.completeCalls).toHaveLength(0);
  });
});

describe('context sent to the model', () => {
  it('includes the live cooking state', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const llm = new FakeLlm([{ content: 'Sure.' }]);

    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'how much pasta?',
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
    );

    const prompt = JSON.stringify(llm.completeCalls[0]);
    expect(prompt).toContain('Weeknight Garlic Butter Pasta');
    expect(prompt).toContain('200 g spaghetti');
    expect(prompt).toContain('Step 2 of 4');
  });

  it('includes only relevant memory, and never another user\'s', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const llm = new FakeLlm([{ content: 'Sure.' }]);

    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'is this going to be spicy?',
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
    );

    const prompt = JSON.stringify(llm.completeCalls[0]);
    expect(prompt).toContain('does not like very spicy food');
    // Bob's contradictory preference must never reach Alice's model call.
    expect(prompt).not.toContain('loves extremely spicy food');
  });

  it('gives the model the tool catalogue', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const llm = new FakeLlm([{ content: 'Sure.' }]);

    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'anything',
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
    );

    const names = (llm.toolSchemas[0] ?? []).map((tool) => tool.name);
    expect(names).toContain('scale_recipe');
    expect(names).toContain('start_timer');
  });

  it('summarises timers and substitutions for the model', async () => {
    const tables = seedTables();
    tables.cooking_sessions![0]!.notes = {
      servings: 4,
      substitutions: [{ from: 'butter', to: 'olive oil', note: '3 to 4' }],
      corrections: ['I already salted the water.'],
    };
    const { db } = makeDb(ALICE, tables);
    const state = await loadCookingState(db, ALICE_SESSION);
    const description = describeState(state.snapshot);

    expect(description).toContain('Cooking for 4 people');
    expect(description).toContain('butter replaced by olive oil');
    expect(description).toContain('I already salted the water.');
    expect(description).toContain('Running timers: none.');
  });
});

describe('tool turns', () => {
  it('runs the tool, refreshes state, then speaks the result', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'make it for six',
        signal: signal(),
        llm: new FakeLlm(
          [{ content: '', toolCalls: [toolCall('scale_recipe', { servings: 6 })] }],
          'You will need 600 g of spaghetti.',
        ),
        tts: new FakeTts(),
      }),
    );

    const order = events.map((event) => event.type);
    expect(order.indexOf('tool.start')).toBeLessThan(order.indexOf('tool.end'));
    expect(order.indexOf('tool.end')).toBeLessThan(order.lastIndexOf('assistant.text'));

    // The state event after the tool carries the new serving size.
    const stateEvents = events.filter((event) => event.type === 'state');
    const last = stateEvents.at(-1);
    expect(last?.type === 'state' ? last.state.servings : 0).toBe(6);
  });

  it('surfaces a tool failure to the model instead of ending the turn', async () => {
    const { db } = makeDb(ALICE, seedTables());
    const llm = new FakeLlm(
      [{ content: '', toolCalls: [toolCall('get_recipe', { recipe_id: 'not-a-uuid' })] }],
      'I could not find that recipe.',
    );

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'open recipe 12',
        signal: signal(),
        llm,
        tts: new FakeTts(),
      }),
    );

    const toolEnd = events.find((event) => event.type === 'tool.end');
    expect(toolEnd?.type === 'tool.end' ? toolEnd.ok : true).toBe(false);
    expect(events.some((event) => event.type === 'turn.end')).toBe(true);

    // The failure reached the model as a tool message so it could recover.
    const followUp = JSON.stringify(llm.streamCalls[0]);
    expect(followUp).toContain('Invalid arguments');
  });
});

describe('user separation across sessions', () => {
  it('keeps two users\' conversations in their own rows', async () => {
    const tables = seedTables();
    const alice = makeDb(ALICE, tables);
    const bob = makeDb(BOB, tables);

    await collect(
      runTurn({
        db: alice.db,
        sessionId: ALICE_SESSION,
        utterance: 'alice speaking',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Hello Alice.' }]),
        tts: new FakeTts(),
      }),
    );
    await collect(
      runTurn({
        db: bob.db,
        sessionId: BOB_SESSION,
        utterance: 'bob speaking',
        signal: signal(),
        llm: new FakeLlm([{ content: 'Hello Bob.' }]),
        tts: new FakeTts(),
      }),
    );

    const aliceTurns = (tables.conversation_turns ?? []).filter((row) => row.user_id === ALICE);
    const bobTurns = (tables.conversation_turns ?? []).filter((row) => row.user_id === BOB);

    expect(aliceTurns.every((row) => row.session_id === ALICE_SESSION)).toBe(true);
    expect(bobTurns.every((row) => row.session_id === BOB_SESSION)).toBe(true);
    expect(JSON.stringify(aliceTurns)).not.toContain('bob speaking');
  });
});
