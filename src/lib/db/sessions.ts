import type { CookingSession, SessionNotes } from '../types';
import { assertOk, type Db } from './context';
import { SESSION_COLUMNS, toSession, type SessionRow } from './rows';

export async function listSessions(db: Db, limit = 10): Promise<CookingSession[]> {
  const { data, error } = await db.supabase
    .from('cooking_sessions')
    .select(SESSION_COLUMNS)
    .eq('user_id', db.userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  assertOk(error, 'cooking sessions');
  return ((data ?? []) as SessionRow[]).map(toSession);
}

export async function getSession(db: Db, sessionId: string): Promise<CookingSession | null> {
  const { data, error } = await db.supabase
    .from('cooking_sessions')
    .select(SESSION_COLUMNS)
    .eq('user_id', db.userId)
    .eq('id', sessionId)
    .maybeSingle();

  assertOk(error, 'cooking session');
  return data ? toSession(data as SessionRow) : null;
}

export async function createSession(
  db: Db,
  recipeId: string | null,
  notes: SessionNotes = {},
): Promise<CookingSession> {
  const { data, error } = await db.supabase
    .from('cooking_sessions')
    .insert({ user_id: db.userId, recipe_id: recipeId, current_step: 0, notes })
    .select(SESSION_COLUMNS)
    .single();

  assertOk(error, 'cooking session');
  return toSession(data as SessionRow);
}

export type SessionPatch = {
  currentStep?: number;
  status?: CookingSession['status'];
  notes?: SessionNotes;
  recipeId?: string | null;
};

export async function updateSession(
  db: Db,
  sessionId: string,
  patch: SessionPatch,
): Promise<CookingSession | null> {
  const payload: Record<string, unknown> = {};
  if (patch.currentStep !== undefined) payload.current_step = patch.currentStep;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.notes !== undefined) payload.notes = patch.notes;
  if (patch.recipeId !== undefined) payload.recipe_id = patch.recipeId;
  if (Object.keys(payload).length === 0) return getSession(db, sessionId);

  const { data, error } = await db.supabase
    .from('cooking_sessions')
    .update(payload)
    .eq('user_id', db.userId)
    .eq('id', sessionId)
    .select(SESSION_COLUMNS)
    .maybeSingle();

  assertOk(error, 'cooking session');
  return data ? toSession(data as SessionRow) : null;
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.supabase
    .from('cooking_sessions')
    .delete()
    .eq('user_id', db.userId)
    .eq('id', sessionId);

  assertOk(error, 'cooking session');
}
