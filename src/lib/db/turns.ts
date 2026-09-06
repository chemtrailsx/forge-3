import type { ConversationTurn } from '../types';
import { assertOk, type Db } from './context';
import { TURN_COLUMNS, toTurn, type TurnRow } from './rows';

export async function recentTurns(
  db: Db,
  sessionId: string,
  limit = 12,
): Promise<ConversationTurn[]> {
  const { data, error } = await db.supabase
    .from('conversation_turns')
    .select(TURN_COLUMNS)
    .eq('user_id', db.userId)
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: false })
    .order('role', { ascending: true })
    .limit(limit);

  assertOk(error, 'conversation');
  // Fetched newest-first so the limit keeps the *recent* window; replayed
  // oldest-first because that is the order a transcript is read in.
  return ((data ?? []) as TurnRow[]).map(toTurn).reverse();
}

export async function nextTurnIndex(db: Db, sessionId: string): Promise<number> {
  const { data, error } = await db.supabase
    .from('conversation_turns')
    .select('turn_index')
    .eq('user_id', db.userId)
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: false })
    .limit(1)
    .maybeSingle();

  assertOk(error, 'conversation');
  const row = data as { turn_index: number } | null;
  return row ? row.turn_index + 1 : 0;
}

export async function recordTurn(
  db: Db,
  input: {
    sessionId: string;
    turnIndex: number;
    role: 'user' | 'assistant';
    text: string;
    heardText?: string | null;
    interrupted?: boolean;
    metrics?: Record<string, unknown>;
  },
): Promise<ConversationTurn> {
  const { data, error } = await db.supabase
    .from('conversation_turns')
    .upsert(
      {
        user_id: db.userId,
        session_id: input.sessionId,
        turn_index: input.turnIndex,
        role: input.role,
        text: input.text,
        heard_text: input.heardText ?? null,
        interrupted: input.interrupted ?? false,
        metrics: input.metrics ?? {},
      },
      { onConflict: 'session_id,turn_index,role' },
    )
    .select(TURN_COLUMNS)
    .single();

  assertOk(error, 'conversation');
  return toTurn(data as TurnRow);
}

/**
 * Rewrite an assistant turn to only what the user actually heard.
 *
 * Called when the *next* request reports how far playback got before the
 * barge-in. Keeping `text` intact and writing `heard_text` alongside means the
 * transcript can still show what was cut, while prompt construction reads only
 * the heard half.
 */
export async function markInterrupted(
  db: Db,
  sessionId: string,
  turnIndex: number,
  heardText: string,
  metrics: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.supabase
    .from('conversation_turns')
    .update({ heard_text: heardText, interrupted: true, metrics })
    .eq('user_id', db.userId)
    .eq('session_id', sessionId)
    .eq('turn_index', turnIndex)
    .eq('role', 'assistant');

  assertOk(error, 'conversation');
}
