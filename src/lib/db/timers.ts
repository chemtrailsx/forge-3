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

export type StartTimerInput = {
  sessionId: string | null;
  durationMs: number;
  label: string;
  kind?: TimerRecord['kind'];
  stepIndex?: number | null;
};

export async function startTimer(db: Db, input: StartTimerInput): Promise<TimerView> {
  const { data, error } = await db.supabase
    .from('timers')
    .insert({
      user_id: db.userId,
      session_id: input.sessionId,
      duration_ms: Math.round(input.durationMs),
      label: input.label.trim() || 'timer',
      kind: input.kind ?? 'timer',
      step_index: input.stepIndex ?? null,
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

/** Cancels whatever is still counting down for a step, when the cook moves on. */
export async function cancelStepTimers(db: Db, sessionId: string, stepIndex: number): Promise<void> {
  const { error } = await db.supabase
    .from('timers')
    .update({ status: 'cancelled' })
    .eq('user_id', db.userId)
    .eq('session_id', sessionId)
    .eq('kind', 'step')
    .eq('step_index', stepIndex)
    .eq('status', 'running');

  assertOk(error, 'timer');
}

/**
 * Records that the assistant has spoken about this timer.
 *
 * This is what makes a reminder fire once. It is written before the words are
 * spoken rather than after, because a reminder said twice is worse than one
 * missed: the cook is already at the pan.
 */
export async function markAnnounced(
  db: Db,
  timerId: string,
  what: 'finished' | 'almost',
): Promise<void> {
  const column = what === 'finished' ? 'reminded_at' : 'heads_up_at';
  const { error } = await db.supabase
    .from('timers')
    .update({ [column]: new Date().toISOString() })
    .eq('user_id', db.userId)
    .eq('id', timerId);

  assertOk(error, 'timer');
}

/**
 * Retires elapsed timers — but only ones the cook has already been told about.
 *
 * An expired timer is the entire trigger for a proactive reminder, so reaping
 * on expiry alone would delete the fact before anything could act on it. It
 * stays until `reminded_at` is set.
 */
export async function reapExpiredTimers(db: Db, timers: TimerView[]): Promise<void> {
  const finished = timers.filter((t) => t.expired && t.remindedAt !== null).map((t) => t.id);
  if (finished.length === 0) return;

  const { error } = await db.supabase
    .from('timers')
    .update({ status: 'completed' })
    .eq('user_id', db.userId)
    .in('id', finished);

  assertOk(error, 'timer');
}
