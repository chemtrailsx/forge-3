import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserContext } from '../auth/session';
import { AppError } from '../errors';

/**
 * The handle every repository function takes.
 *
 * It is constructed only from a verified `UserContext`, so a repository can
 * never be called with a user id that arrived in a request body. The `userId`
 * on it is applied as an explicit `.eq('user_id', ...)` in every query even
 * though RLS would already enforce it — two independent checks, so a mistake
 * in either layer is not sufficient to leak a row.
 */
export type Db = {
  supabase: SupabaseClient;
  userId: string;
};

export function dbFor(ctx: UserContext): Db {
  return { supabase: ctx.supabase, userId: ctx.userId };
}

type PostgrestFailure = { message: string; code?: string };

/** Normalises a PostgREST error into an AppError with a safe message. */
export function assertOk(error: PostgrestFailure | null, what: string): void {
  if (!error) return;
  // 42501 is insufficient_privilege — an RLS denial or an ownership trigger.
  if (error.code === '42501') {
    throw new AppError(`You do not have access to that ${what}.`, 403, 'forbidden');
  }
  console.error(`[db] ${what}:`, error.message);
  throw new AppError(`Could not load your ${what}.`, 500, 'database_error');
}
