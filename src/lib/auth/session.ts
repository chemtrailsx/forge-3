import type { SupabaseClient } from '@supabase/supabase-js';
import { UnauthorizedError } from '../errors';
import { createServerSupabase } from '../supabase/server';

/**
 * The single place identity enters the system.
 *
 * Nothing downstream — no route, no tool, no query builder — accepts a user id
 * as an argument from the outside. They all receive a `UserContext` produced
 * here, from the verified session cookie. That is what makes "never trust a
 * user_id sent by the frontend" a property of the code rather than a rule
 * people have to remember.
 */
export type UserContext = {
  userId: string;
  email: string | null;
  supabase: SupabaseClient;
};

export async function getUserContext(): Promise<UserContext | null> {
  let supabase;
  try {
    supabase = await createServerSupabase();
  } catch {
    // No Supabase configuration means no auth server to verify against, so
    // nobody is authenticated. Failing closed here — rather than throwing —
    // keeps a misconfigured deployment locked instead of erroring on every
    // request, and sends the user to the login page, which explains the setup.
    return null;
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;
  return { userId: user.id, email: user.email ?? null, supabase };
}

export async function requireUser(): Promise<UserContext> {
  const ctx = await getUserContext();
  if (!ctx) throw new UnauthorizedError();
  return ctx;
}
