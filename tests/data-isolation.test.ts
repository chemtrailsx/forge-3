import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  /**
   * The middleware deliberately does not run on `/api`, because it was making
   * every API call verify the same session twice — once there and once in the
   * route — which put an entire round trip to the auth server in front of
   * every spoken reply.
   *
   * That is only safe while the second check is unconditional. This asserts
   * it: a route handler that forgets `requireUser` is now genuinely open, not
   * merely redundant, and this test is the thing that notices.
   */
  it('leaves no API route relying on a gate that no longer runs', () => {
    const apiRoot = resolve(__dirname, '../src/app/api');

    const routeFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) return routeFiles(path);
        return entry.name === 'route.ts' ? [path] : [];
      });

    const files = routeFiles(apiRoot);
    expect(files.length).toBeGreaterThan(0);

    const HANDLER = /export async function (GET|POST|PATCH|PUT|DELETE)\b/g;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const handlers = [...source.matchAll(HANDLER)].map((match) => match[1]);
      expect(handlers.length, `${file} exports no handlers`).toBeGreaterThan(0);

      // `/api/health` is the documented exception: a deploy platform has to be
      // able to probe liveness unauthenticated. It still asks who the caller
      // is, and withholds every configuration detail when the answer is nobody.
      const identifies = /requireUser\(|getUserContext\(/.test(source);
      expect(identifies, `${file} never establishes who is calling`).toBe(true);

      if (!file.includes('health')) {
        const calls = source.match(/requireUser\(\)/g) ?? [];
        expect(
          calls.length,
          `${file} has ${handlers.length} handlers but ${calls.length} requireUser() calls`,
        ).toBeGreaterThanOrEqual(handlers.length);
      }
    }
  });

  // Importing the real module pulls in `next/server` and the Supabase SSR
  // client, which is slow to transform once and worth it: this asserts on the
  // matcher Next actually loads, not on a copy of it in the test.
  it('does not run the middleware on API routes, and does run it on pages', { timeout: 30_000 }, async () => {
    const { config } = await import('@/middleware');
    const pattern = new RegExp(`^${String(config.matcher[0])}$`);

    for (const path of ['/api/turn', '/api/sessions', '/api/stt']) {
      expect(pattern.test(path), `${path} should be handled by its own route`).toBe(false);
    }
    // Pages still get their session refreshed on navigation, which is what
    // stops long sessions from ending in a surprise logout.
    for (const path of ['/dashboard', '/cook/abc', '/profile', '/login']) {
      expect(pattern.test(path), `${path} still needs the middleware`).toBe(true);
    }
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
