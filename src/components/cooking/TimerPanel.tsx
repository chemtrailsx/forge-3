'use client';

import { useEffect, useState } from 'react';
import type { TimerView } from '@/lib/types';

/**
 * Timers count down locally from `startedAt + durationMs`, which the server
 * sent. Ticking a local counter would drift; recomputing from the absolute end
 * time each second cannot.
 *
 * One list, not two. Whether the assistant started the countdown or the cook
 * asked for it, the answer to "what is happening right now that I am not
 * watching" is the same — and seeing it is what makes the automatic reminder
 * feel expected rather than startling.
 */
export function TimerPanel({ timers }: { timers: TimerView[] }) {
  /**
   * The clock is read in an effect, never during render.
   *
   * Reading `Date.now()` while rendering is impure — the same props produce a
   * different tree each call — and it is a hydration hazard besides: the
   * server renders one instant and the browser another, so the first paint
   * disagrees with the markup it is replacing. Holding "now" in state makes
   * every row a pure function of its props and gives all of them the same
   * instant to count from.
   */
  const [now, setNow] = useState<number | null>(null);
  const total = timers.length;

  useEffect(() => {
    if (total === 0) return;
    // Only subscribe. Seeding the value synchronously here would be a
    // cascading render for no gain: until the first tick, each row falls back
    // to the remaining time the server already computed, which is at most half
    // a second stale.
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [total]);

  if (total === 0) {
    return (
      <section className="card">
        <h3>On the go</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Nothing cooking. Say &ldquo;set a timer for eight minutes&rdquo; any time.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h3>On the go</h3>
      <ul className="plain">
        {timers.map((timer) => (
          <TimerRow key={timer.id} timer={timer} now={now} />
        ))}
      </ul>
    </section>
  );
}

function TimerRow({ timer, now }: { timer: TimerView; now: number | null }) {
  const endsAt = new Date(timer.startedAt).getTime() + timer.durationMs;

  // `now` is null for the single frame before the first effect runs. Falling
  // back to the value the server already computed keeps that frame correct
  // rather than blank or briefly wrong.
  const remaining = now === null ? timer.remainingMs : Math.max(0, endsAt - now);

  return (
    <li>
      <span>{timer.label}</span>
      <span className={`timer${remaining === 0 ? ' expired' : ''}`}>
        {remaining === 0 ? 'ready' : formatRemaining(remaining)}
      </span>
    </li>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
