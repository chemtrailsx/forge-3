import type { TimerRecord, TimerView } from '../types';
import { assertOk, type Db } from './context';
import { TIMER_COLUMNS, toTimer, type TimerRow } from './rows';

/**
 * Remaining time is derived, never stored. Storing a countdown would drift the
 * moment the page is backgrounded or the server restarts; `started_at +
 * duration_ms` is true regardless of who is awake.
 */
export function toView(timer: TimerRecord, now = Date.now()): TimerView {
  const endsAt = new Date(timer.startedAt).getTime() + timer.durationMs;
  const remainingMs = Math.max(0, endsAt - now);
  return { ...timer, remainingMs, expired: remainingMs === 0 };
}

export async function listActiveTimers(db: Db, sessionId?: string): Promise<TimerView[]> {
  let query = db.supabase
    .from('timers')
    .select(TIMER_COLUMNS)
    .eq('user_id', db.userId)
    .eq('status', 'running');

  if (sessionId) query = query.eq('session_id', sessionId);

  const { data, error } = await query.order('started_at', { ascending: true }).limit(10);
  assertOk(error, 'timers');
  return ((data ?? []) as TimerRow[]).map((row) => toView(toTimer(row)));
}

export async function startTimer(
  db: Db,
  sessionId: string | null,
  durationMs: number,
  label: string,
): Promise<TimerView> {
  const { data, error } = await db.supabase
    .from('timers')
    .insert({
      user_id: db.userId,
      session_id: sessionId,
      duration_ms: Math.round(durationMs),
      label: label.trim() || 'timer',
    })
    .select(TIMER_COLUMNS)
    .single();

  assertOk(error, 'timer');
  return toView(toTimer(data as TimerRow));
}

export async function cancelTimer(db: Db, timerId: string): Promise<void> {
  const { error } = await db.supabase
    .from('timers')
    .update({ status: 'cancelled' })
    .eq('user_id', db.userId)
    .eq('id', timerId);

  assertOk(error, 'timer');
}

/** Marks elapsed timers completed so they stop appearing as active. */
export async function reapExpiredTimers(db: Db, timers: TimerView[]): Promise<void> {
  const expired = timers.filter((t) => t.expired).map((t) => t.id);
  if (expired.length === 0) return;

  const { error } = await db.supabase
    .from('timers')
    .update({ status: 'completed' })
    .eq('user_id', db.userId)
    .in('id', expired);

  assertOk(error, 'timer');
}
