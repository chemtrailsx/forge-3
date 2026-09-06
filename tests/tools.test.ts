import { describe, expect, it } from 'vitest';
import { loadCookingState } from '@/lib/cooking/state';
import { executeTool, TOOLS, toolSchemas, fillerFor } from '@/lib/tools/registry';
import type { ToolContext } from '@/lib/tools/types';
import type { Db } from '@/lib/db/context';
import { ALICE, ALICE_SESSION, BOB_RECIPE, makeDb, seedTables } from './helpers/fixtures';
import type { Tables } from './helpers/fake-supabase';

async function context(tables: Tables = seedTables()): Promise<{ ctx: ToolContext; db: Db; tables: Tables }> {
  const { db } = makeDb(ALICE, tables);
  const state = await loadCookingState(db, ALICE_SESSION);
  return {
    tables,
    db,
    ctx: { db, state, reload: () => loadCookingState(db, ALICE_SESSION) },
  };
}

const signal = new AbortController().signal;

describe('tool surface', () => {
  it('exposes every tool the spec requires', () => {
    const names = TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'get_recent_cooking_sessions',
        'get_recipe',
        'get_timer_status',
        'save_recipe',
        'save_user_preference',
        'scale_recipe',
        'search_user_recipes',
        'set_current_step',
        'start_timer',
        'suggest_substitution',
      ].sort(),
    );
  });

  it('describes every tool to the model with a JSON schema', () => {
    for (const schema of toolSchemas()) {
      expect(schema.description.length).toBeGreaterThan(20);
      expect(schema.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('argument validation', () => {
  it('rejects malformed arguments as a tool error the model can recover from', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('scale_recipe', '{"servings":"six"}', ctx, signal);

    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.content)).toHaveProperty('error', 'Invalid arguments.');
  });

  it('rejects arguments that are not JSON at all', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('start_timer', 'not json', ctx, signal);
    expect(outcome.ok).toBe(false);
  });

  it('reports an unknown tool without throwing', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('delete_everything', '{}', ctx, signal);
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Unknown tool');
  });
});

describe('ownership', () => {
  it("refuses to read another user's recipe even when the model asks for it by id", async () => {
    const { ctx } = await context();
    const outcome = await executeTool('get_recipe', JSON.stringify({ recipe_id: BOB_RECIPE }), ctx, signal);

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('not found');
  });

  it('searches only the signed-in user\'s recipes', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('search_user_recipes', JSON.stringify({ query: 'chilli' }), ctx, signal);
    expect(outcome.content).not.toContain('Secret Chilli');
  });
});

describe('scale_recipe', () => {
  it('scales quantities and applies the change to the live session', async () => {
    const { ctx, db, tables } = await context();
    const outcome = await executeTool('scale_recipe', JSON.stringify({ servings: 6 }), ctx, signal);
    const data = JSON.parse(outcome.content) as { ingredients: string[]; to_servings: number };

    expect(outcome.ok).toBe(true);
    expect(outcome.stateChanged).toBe(true);
    // 200 g for two becomes 600 g for six, rounded to a sayable number.
    expect(data.ingredients).toContain('600 g spaghetti');
    // A quantity-less ingredient must survive scaling intact.
    expect(data.ingredients).toContain('salt, for the water');

    const session = tables.cooking_sessions?.find((row) => row.id === ALICE_SESSION);
    expect((session?.notes as { servings?: number }).servings).toBe(6);

    // And the reloaded state must agree, so the next answer uses the new amounts.
    const reloaded = await loadCookingState(db, ALICE_SESSION);
    expect(reloaded.snapshot.servings).toBe(6);
    expect(reloaded.snapshot.ingredients[0]?.quantity).toBe(600);
  });
});

describe('suggest_substitution', () => {
  it('returns a curated ratio for a known ingredient', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('suggest_substitution', JSON.stringify({ ingredient: 'salted butter' }), ctx, signal);
    const data = JSON.parse(outcome.content) as { found: boolean; options: Array<{ ratio: string }> };

    expect(data.found).toBe(true);
    expect(data.options[0]?.ratio).toBeTruthy();
  });

  it('says it has nothing rather than inventing a ratio', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('suggest_substitution', JSON.stringify({ ingredient: 'saffron' }), ctx, signal);
    const data = JSON.parse(outcome.content) as { found: boolean; note: string };

    expect(data.found).toBe(false);
    expect(data.note).toMatch(/do not have a reliable swap/i);
  });

  it('records an accepted substitution in the cooking session', async () => {
    const { ctx, db } = await context();
    await executeTool('suggest_substitution', JSON.stringify({ ingredient: 'butter', accept: true }), ctx, signal);

    const state = await loadCookingState(db, ALICE_SESSION);
    expect(state.snapshot.substitutions[0]).toMatchObject({ from: 'butter', to: 'olive oil' });
  });
});

describe('timers', () => {
  it('starts a timer against the current session and reports it back', async () => {
    const { ctx, db } = await context();

    const started = await executeTool(
      'start_timer',
      JSON.stringify({ duration_seconds: 480, label: 'pasta' }),
      ctx,
      signal,
    );
    expect(JSON.parse(started.content)).toMatchObject({ started: true, duration: '8 minutes' });

    const status = await executeTool('get_timer_status', '{}', await refresh(ctx, db), signal);
    const data = JSON.parse(status.content) as { count: number; timers: Array<{ label: string }> };
    expect(data.count).toBe(1);
    expect(data.timers[0]?.label).toBe('pasta');
  });
});

describe('step movement', () => {
  it('clamps a step past the end of the recipe instead of failing', async () => {
    const { ctx } = await context();
    const outcome = await executeTool('set_current_step', JSON.stringify({ step: 99 }), ctx, signal);
    const data = JSON.parse(outcome.content) as { current_step: number; total_steps: number };

    expect(data.current_step).toBe(data.total_steps);
  });
});

describe('preferences', () => {
  it('saves a spoken preference as durable memory', async () => {
    const { ctx, tables } = await context();
    await executeTool(
      'save_user_preference',
      JSON.stringify({ key: 'usual_servings', value: 'usually cooks for four', kind: 'preference' }),
      ctx,
      signal,
    );

    const saved = tables.user_memory?.find((row) => row.key === 'usual_servings');
    expect(saved).toBeDefined();
    // A servings preference also lands in the structured profile, which is
    // read on every turn.
    const profile = tables.profiles?.find((row) => row.id === ALICE);
    expect((profile?.preferences as { defaultServings?: number }).defaultServings).toBe(4);
  });
});

describe('fillers', () => {
  it('gives a filler for slow lookups and none for local state changes', () => {
    expect(fillerFor('scale_recipe', 0)).toBeTruthy();
    expect(fillerFor('search_user_recipes', 0)).toBeTruthy();
    expect(fillerFor('set_current_step', 0)).toBeNull();
  });

  it('never claims a result before the tool has returned one', () => {
    const forbidden = /\b(you'?ll need|it is|that is|the answer|grams|minutes)\b/i;
    for (const tool of TOOLS) {
      for (const filler of tool.filler) {
        expect(filler, `${tool.name}: "${filler}"`).not.toMatch(forbidden);
        expect(filler.length).toBeLessThan(60);
      }
    }
  });
});

async function refresh(ctx: ToolContext, db: Db): Promise<ToolContext> {
  const state = await loadCookingState(db, ALICE_SESSION);
  return { ...ctx, state };
}
