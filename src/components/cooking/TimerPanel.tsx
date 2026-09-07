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
  const [, setTick] = useState(0);
  const total = timers.length;

  useEffect(() => {
    if (total === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
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
          <TimerRow key={timer.id} timer={timer} />
        ))}
      </ul>
    </section>
  );
}

function TimerRow({ timer }: { timer: TimerView }) {
  const endsAt = new Date(timer.startedAt).getTime() + timer.durationMs;
  const remaining = Math.max(0, endsAt - Date.now());

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
