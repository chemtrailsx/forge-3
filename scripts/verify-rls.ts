/**
 * Proves user isolation against the real database.
 *
 * The unit tests in `tests/data-isolation.test.ts` run against an in-memory
 * double that *simulates* RLS. That is fast and catches application-layer
 * mistakes, but it cannot prove the policies in
 * `supabase/migrations/0002_rls.sql` actually do what they claim — only
 * Postgres can do that. This script closes the gap.
 *
 * It creates two throwaway users, signs in as each to obtain real JWTs, and
 * then attacks the database with one user's token while trying to reach the
 * other's rows. Every request goes through PostgREST exactly as a browser's
 * would, so what is being tested is the deployed policy set, not a model of it.
 *
 *   npm run verify:rls
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY, because creating and deleting users is
 * an admin operation. The service role is used *only* for setup and teardown —
 * never for the assertions themselves, which run as ordinary users.
 *
 * Both users are deleted at the end, including on failure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile('.env.local');
loadEnvFile('.env');

const SUPABASE_URL = required('NEXT_PUBLIC_SUPABASE_URL');
const PUBLISHABLE =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
const SERVICE_ROLE = required('SUPABASE_SERVICE_ROLE_KEY');

const PASSWORD = 'verify-rls-throwaway-password-1';

type User = { id: string; email: string; token: string };

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// --- admin helpers (setup/teardown only) ------------------------------------

async function createUser(email: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    // email_confirm bypasses the mailer so this works whether or not the
    // project requires confirmation.
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`createUser ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { id: string }).id;
}

async function deleteUser(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  }).catch(() => undefined);
}

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`signIn ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** A PostgREST request as an ordinary signed-in user. */
async function asUser(
  user: User,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: PUBLISHABLE,
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const emails = [`rls-a-${stamp}@example.com`, `rls-b-${stamp}@example.com`];
  const ids: string[] = [];

  try {
    console.log('Creating two throwaway users...\n');
    for (const email of emails) ids.push(await createUser(email));

    const [alice, bob] = await Promise.all(
      emails.map(async (email, index) => ({
        id: ids[index] as string,
        email,
        token: await signIn(email),
      })),
    );
    if (!alice || !bob) throw new Error('could not sign in as both users');

    // --- the new-user trigger ------------------------------------------------
    const aliceProfile = await asUser(alice, 'profiles?select=id');
    check(
      'new user gets exactly one profile row',
      Array.isArray(aliceProfile.body) && aliceProfile.body.length === 1,
      `saw ${JSON.stringify(aliceProfile.body).slice(0, 120)}`,
    );

    const aliceRecipes = await asUser(alice, 'recipes?select=id,title,user_id');
    const aliceRows = (aliceRecipes.body ?? []) as Array<{ id: string; user_id: string }>;
    check(
      'new user gets the starter recipe',
      aliceRows.length === 1,
      `saw ${aliceRows.length} recipe(s)`,
    );

    const bobRecipes = await asUser(bob, 'recipes?select=id,title,user_id');
    const bobRows = (bobRecipes.body ?? []) as Array<{ id: string; user_id: string }>;
    const bobRecipeId = bobRows[0]?.id;
    if (!bobRecipeId) throw new Error("could not read Bob's own starter recipe");

    // --- reads ---------------------------------------------------------------
    check(
      'a listing returns only the caller\'s own rows',
      aliceRows.every((row) => row.user_id === alice.id),
      `${aliceRows.length} row(s), all owned by caller`,
    );

    const targeted = await asUser(alice, `recipes?select=id&id=eq.${bobRecipeId}`);
    check(
      "another user's recipe is invisible even when addressed by id",
      Array.isArray(targeted.body) && targeted.body.length === 0,
      `status ${targeted.status}, body ${JSON.stringify(targeted.body).slice(0, 80)}`,
    );

    for (const table of ['cooking_sessions', 'user_memory', 'timers', 'conversation_turns']) {
      const result = await asUser(alice, `${table}?select=user_id`);
      const rows = (result.body ?? []) as Array<{ user_id: string }>;
      check(
        `${table}: no rows belonging to another user`,
        Array.isArray(rows) && rows.every((row) => row.user_id === alice.id),
        `${rows.length} row(s)`,
      );
    }

    // --- writes --------------------------------------------------------------
    const forgedInsert = await asUser(alice, 'recipes', {
      method: 'POST',
      body: JSON.stringify({ user_id: bob.id, title: 'planted by Alice', servings: 2 }),
    });
    check(
      "cannot insert a row owned by another user",
      forgedInsert.status === 403 || forgedInsert.status === 401,
      `status ${forgedInsert.status}`,
    );

    const forgedUpdate = await asUser(alice, `recipes?id=eq.${bobRecipeId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ title: 'renamed by Alice' }),
    });
    check(
      "updating another user's recipe changes nothing",
      Array.isArray(forgedUpdate.body) && forgedUpdate.body.length === 0,
      `status ${forgedUpdate.status}, ${JSON.stringify(forgedUpdate.body).slice(0, 80)}`,
    );

    const forgedDelete = await asUser(alice, `recipes?id=eq.${bobRecipeId}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    check(
      "deleting another user's recipe deletes nothing",
      Array.isArray(forgedDelete.body) && forgedDelete.body.length === 0,
      `status ${forgedDelete.status}`,
    );

    // Bob confirms his row survived both attacks.
    const bobAfter = await asUser(bob, `recipes?select=id,title&id=eq.${bobRecipeId}`);
    const bobAfterRows = (bobAfter.body ?? []) as Array<{ title: string }>;
    check(
      "the victim's row is intact and unrenamed",
      bobAfterRows.length === 1 && bobAfterRows[0]?.title !== 'renamed by Alice',
      `title ${JSON.stringify(bobAfterRows[0]?.title)}`,
    );

    // --- the ownership trigger ----------------------------------------------
    // RLS alone would allow this: the row Alice writes is hers, it just points
    // at a recipe that is not. The trigger in 0002 is what refuses it.
    const crossReference = await asUser(alice, 'cooking_sessions', {
      method: 'POST',
      body: JSON.stringify({ user_id: alice.id, recipe_id: bobRecipeId }),
    });
    check(
      'cannot start a session against a recipe owned by someone else',
      crossReference.status >= 400,
      `status ${crossReference.status}`,
    );

    // --- anonymous -----------------------------------------------------------
    const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/recipes?select=id`, {
      headers: { apikey: PUBLISHABLE },
    });
    const anonymousRows = (await anonymous.json().catch(() => [])) as unknown[];
    check(
      'an anonymous caller sees no recipes at all',
      !Array.isArray(anonymousRows) || anonymousRows.length === 0,
      `status ${anonymous.status}`,
    );
  } finally {
    for (const id of ids) await deleteUser(id);
    console.log('\nThrowaway users deleted.');
  }

  console.log(`\n${passed}/${passed + failed} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set in .env.local`);
    process.exit(1);
  }
  return value;
}

function loadEnvFile(file: string): void {
  try {
    const contents = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Absent file is fine.
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
