import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRecipe, listRecipes, searchRecipes, deleteRecipe, createRecipe } from '@/lib/db/recipes';
import { getSession, listSessions, updateSession } from '@/lib/db/sessions';
import { listMemory, saveMemory } from '@/lib/db/memory';
import { loadCookingState } from '@/lib/cooking/state';
import { recentTurns, recordTurn } from '@/lib/db/turns';
import { ALICE, ALICE_RECIPE, ALICE_SESSION, BOB, BOB_RECIPE, BOB_SESSION, makeDb, seedTables } from './helpers/fixtures';

/**
 * User isolation is the property the whole product rests on, so it is tested
 * two ways at once:
 *
 *  - behaviourally: Alice's client cannot see Bob's rows, because the fake
 *    enforces RLS the way Postgres does;
 *  - structurally: every read also carries an explicit `user_id` filter, so
 *    the application layer is not relying on RLS alone.
 *
 * A regression in either layer fails a test here.
 */

describe('cross-user reads', () => {
  it("cannot read another user's recipe by id", async () => {
    const { db } = makeDb(ALICE);
    expect(await getRecipe(db, BOB_RECIPE)).toBeNull();
    expect(await getRecipe(db, ALICE_RECIPE)).not.toBeNull();
  });

  it('lists only the signed-in user\'s recipes', async () => {
    const alice = makeDb(ALICE);
    const bob = makeDb(BOB);

    const aliceRecipes = await listRecipes(alice.db);
    const bobRecipes = await listRecipes(bob.db);

    expect(aliceRecipes.map((r) => r.title)).toEqual(['Weeknight Garlic Butter Pasta']);
    expect(bobRecipes.map((r) => r.title)).toEqual(["Bob's Secret Chilli"]);
  });

  it('never returns another user\'s recipe from a search that would match it', async () => {
    const { db } = makeDb(ALICE);
    const results = await searchRecipes(db, 'chilli');
    expect(results.every((recipe) => recipe.userId === ALICE)).toBe(true);
    expect(results.map((r) => r.title)).not.toContain("Bob's Secret Chilli");
  });

  it("cannot open another user's cooking session", async () => {
    const { db } = makeDb(ALICE);
    expect(await getSession(db, BOB_SESSION)).toBeNull();
    await expect(loadCookingState(db, BOB_SESSION)).rejects.toThrow(/not found/i);
  });

  it('lists only the signed-in user\'s sessions and memory', async () => {
    const { db } = makeDb(BOB);
    const sessions = await listSessions(db);
    const memory = await listMemory(db);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(BOB_SESSION);
    expect(memory.map((entry) => entry.value)).toEqual(['loves extremely spicy food']);
  });
});

describe('cross-user writes', () => {
  it("silently affects nothing when updating another user's session", async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    const result = await updateSession(db, BOB_SESSION, { currentStep: 99 });

    expect(result).toBeNull();
    const bobSession = tables.cooking_sessions?.find((row) => row.id === BOB_SESSION);
    expect(bobSession?.current_step).toBe(0);
  });

  it("cannot delete another user's recipe", async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    await deleteRecipe(db, BOB_RECIPE);

    expect(tables.recipes?.some((row) => row.id === BOB_RECIPE)).toBe(true);
  });

  it('stamps new rows with the session user, not anything supplied', async () => {
    const { db, fake } = makeDb(ALICE);

    const recipe = await createRecipe(db, {
      title: 'Test bake',
      ingredients: [],
      steps: [],
      servings: 2,
    });
    await saveMemory(db, 'Likes_Lemon', 'adds lemon to everything');
    await recordTurn(db, {
      sessionId: ALICE_SESSION,
      turnIndex: 0,
      role: 'user',
      text: 'hello',
    });

    expect(recipe.userId).toBe(ALICE);
    for (const call of fake.calls.filter((c) => c.op === 'insert' || c.op === 'upsert')) {
      const rows = Array.isArray(call.payload) ? call.payload : [call.payload];
      for (const row of rows) {
        if (row && 'user_id' in row) expect(row.user_id).toBe(ALICE);
      }
    }
  });
});

describe('middleware placement', () => {
  /**
   * This project uses a `src/` directory, so Next only loads middleware from
   * `src/middleware.ts`. At the repository root it is silently ignored — no
   * warning, no error, and the app still behaves correctly because every route
   * and page authenticates independently. The only visible symptom is that
   * sessions stop being refreshed on navigation, which surfaces later as
   * random logouts. Cheap to assert, expensive to rediscover.
   */
  it('lives where Next will actually load it', () => {
    const root = resolve(__dirname, '..');
    expect(existsSync(resolve(root, 'src/app'))).toBe(true);
    expect(existsSync(resolve(root, 'src/middleware.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'middleware.ts'))).toBe(false);
  });
});

describe('defence in depth', () => {
  it('adds an explicit user_id filter to every read, independently of RLS', async () => {
    const { db, fake } = makeDb(ALICE);

    await listRecipes(db);
    await getRecipe(db, ALICE_RECIPE);
    await listSessions(db);
    await getSession(db, ALICE_SESSION);
    await listMemory(db);
    await recentTurns(db, ALICE_SESSION);

    const selects = fake.calls.filter((call) => call.op === 'select');
    expect(selects.length).toBeGreaterThan(0);

    for (const call of selects) {
      const scoped = call.filters.some(
        (filter) => filter.op === 'eq' && filter.column === 'user_id' && filter.value === ALICE,
      );
      expect(scoped, `${call.table} select was not scoped by user_id`).toBe(true);
    }
  });

  it('scopes every write by user_id as well', async () => {
    const { db, fake } = makeDb(ALICE);

    await updateSession(db, ALICE_SESSION, { currentStep: 2 });
    await deleteRecipe(db, ALICE_RECIPE);

    for (const call of fake.calls.filter((c) => c.op === 'update' || c.op === 'delete')) {
      const scoped = call.filters.some(
        (filter) => filter.op === 'eq' && filter.column === 'user_id' && filter.value === ALICE,
      );
      expect(scoped, `${call.table} ${call.op} was not scoped by user_id`).toBe(true);
    }
  });
});
