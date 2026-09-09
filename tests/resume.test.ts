import { describe, expect, it } from 'vitest';
import { isSameDish } from '@/lib/cooking/same-dish';
import { executeTool } from '@/lib/tools/registry';
import { loadCookingState } from '@/lib/cooking/state';
import { describeState } from '@/lib/llm/prompt';
import { recentTurns } from '@/lib/db/turns';
import { ALICE, ALICE_RECIPE, ALICE_SESSION, makeDb, seedTables } from './helpers/fixtures';

/**
 * Reported: "when i resume a session it restarts the recipe."
 *
 * `plan_recipe` attaches a new recipe and sets the step back to one. That is
 * right when a dish is being chosen and ruinous when one is in the pan — and a
 * cook coming back says "we were making the pasta", which reads exactly like
 * asking for pasta to be planned.
 */

const signal = () => new AbortController().signal;

async function contextFor(tables = seedTables()) {
  const { db } = makeDb(ALICE, tables);
  const state = await loadCookingState(db, ALICE_SESSION);
  return { db, tables, ctx: { db, state, reload: () => loadCookingState(db, ALICE_SESSION) } };
}

const RECIPE_ARGS = {
  title: 'Weeknight Garlic Butter Pasta',
  servings: 2,
  ingredients: ['200 g spaghetti', '40 g butter'],
  steps: [{ text: 'Boil the water.', attention: 'passive', durationSeconds: 480 }],
};

describe('resuming a dish already in the pan', () => {
  it('does not re-plan the dish they are already cooking', async () => {
    const { ctx, tables } = await contextFor();
    const before = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect(before?.current_step).toBe(1);

    const result = await executeTool('plan_recipe', JSON.stringify(RECIPE_ARGS), ctx, signal());
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data.planned).toBe(false);
    expect(data.reason).toBe('already_cooking_this');
    expect(data.on_step).toBe(2);

    // The thing that actually matters: their place is untouched.
    const after = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect(after?.current_step).toBe(1);
    expect(after?.recipe_id).toBe(ALICE_RECIPE);
    expect(result.stateChanged).toBeFalsy();
  });

  it('recognises the dish from the half-name a returning cook uses', async () => {
    const { ctx } = await contextFor();
    const result = await executeTool(
      'plan_recipe',
      JSON.stringify({ ...RECIPE_ARGS, title: 'garlic butter pasta' }),
      ctx,
      signal(),
    );
    expect((JSON.parse(result.content) as { reason?: string }).reason).toBe('already_cooking_this');
  });

  it('asks before throwing away a dish in progress for a different one', async () => {
    const { ctx, tables } = await contextFor();
    const result = await executeTool(
      'plan_recipe',
      JSON.stringify({ ...RECIPE_ARGS, title: 'Chicken Biryani' }),
      ctx,
      signal(),
    );
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data.planned).toBe(false);
    expect(data.reason).toBe('dish_in_progress');
    expect(tables.cooking_sessions?.find((r) => r.id === ALICE_SESSION)?.current_step).toBe(1);
  });

  it('changes dish when the cook has actually said so', async () => {
    const { ctx, tables } = await contextFor();
    const result = await executeTool(
      'plan_recipe',
      JSON.stringify({ ...RECIPE_ARGS, title: 'Chicken Biryani', replaces_current_dish: true }),
      ctx,
      signal(),
    );

    expect((JSON.parse(result.content) as { title?: string }).title).toBe('Chicken Biryani');
    const after = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect(after?.current_step).toBe(0);
    expect(after?.recipe_id).not.toBe(ALICE_RECIPE);
  });

  it('still plans freely when nothing is under way', async () => {
    const tables = seedTables();
    const session = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    if (session) {
      session.current_step = 0;
      session.recipe_id = null;
    }
    const { ctx } = await contextFor(tables);
    const result = await executeTool('plan_recipe', JSON.stringify(RECIPE_ARGS), ctx, signal());
    expect((JSON.parse(result.content) as { title?: string }).title).toBe(RECIPE_ARGS.title);
  });

  it('tells the model in plain words that the dish is under way', async () => {
    const { ctx } = await contextFor();
    const described = describeState(ctx.state.snapshot);
    expect(described).toMatch(/already under way/i);
    expect(described).toMatch(/do not start from the beginning/i);
  });
});

describe('telling one dish from another', () => {
  it('matches what a cook actually says when coming back', () => {
    expect(isSameDish('white sauce pasta', 'White Sauce Chicken Pasta with Garlic Bread')).toBe(true);
    expect(isSameDish('the butter chicken', 'Butter Chicken')).toBe(true);
    expect(isSameDish('garlic butter pasta', 'Weeknight Garlic Butter Pasta')).toBe(true);
    expect(isSameDish('paneer tikka masala', 'Paneer Tikka Masala')).toBe(true);
  });

  it('does not confuse two different dishes that share a word', () => {
    expect(isSameDish('butter chicken', 'chicken biryani')).toBe(false);
    expect(isSameDish('chicken korma', 'chicken tikka masala')).toBe(false);
    expect(isSameDish('garlic butter pasta', 'chicken biryani')).toBe(false);
    expect(isSameDish('pasta', 'biryani')).toBe(false);
  });
});

describe('coming back to a conversation, not a blank page', () => {
  /*
   * Reported: "have previous chat history when i open up the session to resume
   * it." The feed started empty on every load, so a cook returning to a dish
   * saw no sign that anything had been said — the app looked like it had
   * forgotten them, whatever the state underneath knew.
   */
  const withHistory = () => {
    const tables = seedTables();
    (tables.conversation_turns ??= []).push(
      { id: 't1', user_id: ALICE, session_id: ALICE_SESSION, turn_index: 0, role: 'user', text: 'what am I making again?', heard_text: null, interrupted: false, metrics: {}, created_at: '2026-09-10T10:00:00.000Z' },
      { id: 't2', user_id: ALICE, session_id: ALICE_SESSION, turn_index: 0, role: 'assistant', text: 'Garlic butter pasta. You are on step two, melting the butter.', heard_text: null, interrupted: false, metrics: {}, created_at: '2026-09-10T10:00:01.000Z' },
      { id: 't3', user_id: ALICE, session_id: ALICE_SESSION, turn_index: 1, role: 'assistant', text: 'Now toss the pasta through the garlic butter and serve.', heard_text: 'Now toss the pasta', interrupted: true, metrics: {}, created_at: '2026-09-10T10:01:00.000Z' },
    );
    return tables;
  };

  it('reads back what was said in this session, oldest first', async () => {
    const { db } = makeDb(ALICE, withHistory());
    const history = await recentTurns(db, ALICE_SESSION, 20);

    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(history[0]?.text).toBe('what am I making again?');
  });

  it('shows what the cook actually heard of a turn that was cut off', async () => {
    const { db } = makeDb(ALICE, withHistory());
    const history = await recentTurns(db, ALICE_SESSION, 20);

    // This is the mapping the cook page performs. Replaying the full sentence
    // would put words in the feed that never reached the room.
    const entries = history.map((turn) => ({
      text: turn.heardText ?? turn.text,
      interrupted: turn.interrupted,
    }));

    const cutOff = entries[2];
    expect(cutOff?.text).toBe('Now toss the pasta');
    expect(cutOff?.interrupted).toBe(true);
    expect(cutOff?.text).not.toContain('serve');
  });

  it('keeps one cook out of another cooks session history', async () => {
    const tables = withHistory();
    const { db } = makeDb('22222222-2222-4222-8222-222222222222', tables);
    expect(await recentTurns(db, ALICE_SESSION, 20)).toEqual([]);
  });
});

describe('putting a dish away', () => {
  /*
   * Reported: "add option to close the recipe/stop the recipe which makes u go
   * back to step 0". It is also the escape hatch that makes the guard on
   * re-planning safe — there has to be a way to say "I have given up on this"
   * that does not involve losing the session.
   */
  it('empties the session and goes back to the beginning', async () => {
    const { ctx, tables } = await contextFor();
    const result = await executeTool('close_recipe', '{}', ctx, signal());
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data.closed).toBe(true);
    expect(data.was).toBe('Weeknight Garlic Butter Pasta');

    const after = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect(after?.recipe_id).toBeNull();
    expect(after?.current_step).toBe(0);
    expect(result.stateChanged).toBe(true);
  });

  it('keeps the recipe itself — only the session lets go', async () => {
    const { ctx, tables } = await contextFor();
    await executeTool('close_recipe', '{}', ctx, signal());

    // Written for this cook and still theirs; closing a session is not a
    // reason to lose it.
    expect(tables.recipes?.some((row) => row.id === ALICE_RECIPE)).toBe(true);
  });

  it('lets the next dish be planned freely once the session is empty', async () => {
    const { db, tables } = await contextFor();
    const closeCtx = {
      db,
      state: await loadCookingState(db, ALICE_SESSION),
      reload: () => loadCookingState(db, ALICE_SESSION),
    };
    await executeTool('close_recipe', '{}', closeCtx, signal());

    // A fresh context, as the next turn would build.
    const planCtx = {
      db,
      state: await loadCookingState(db, ALICE_SESSION),
      reload: () => loadCookingState(db, ALICE_SESSION),
    };
    const planned = await executeTool(
      'plan_recipe',
      JSON.stringify({ ...RECIPE_ARGS, title: 'Chicken Biryani' }),
      planCtx,
      signal(),
    );

    // No confirmation needed: there is nothing left to throw away.
    expect((JSON.parse(planned.content) as { title?: string }).title).toBe('Chicken Biryani');
    expect(tables.cooking_sessions?.find((r) => r.id === ALICE_SESSION)?.current_step).toBe(0);
  });

  it('says so plainly when there is nothing to close', async () => {
    const tables = seedTables();
    const session = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    if (session) session.recipe_id = null;
    const { ctx } = await contextFor(tables);

    const result = await executeTool('close_recipe', '{}', ctx, signal());
    expect((JSON.parse(result.content) as { reason?: string }).reason).toBe('nothing_in_progress');
  });
});
