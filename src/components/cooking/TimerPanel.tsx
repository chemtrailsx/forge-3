'use client';

import { useEffect, useState } from 'react';
import type { TimerView } from '@/lib/types';

/**
 * Timers count down locally from `startedAt + durationMs`, which the server
 * sent. Ticking a local counter would drift; recomputing from the absolute end
 * time each second cannot.
 */
export function TimerPanel({ timers }: { timers: TimerView[] }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (timers.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [timers.length]);

  if (timers.length === 0) {
    return (
      <section className="card">
        <h3>Timers</h3>
        <p className="muted small" style={{ margin: 0 }}>
          None running. Say &ldquo;set a timer for eight minutes&rdquo;.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h3>Timers</h3>
      <ul className="plain">
        {timers.map((timer) => {
          const endsAt = new Date(timer.startedAt).getTime() + timer.durationMs;
          const remaining = Math.max(0, endsAt - Date.now());
          return (
            <li key={timer.id}>
              <span>{timer.label}</span>
              <span className={`timer${remaining === 0 ? ' expired' : ''}`}>
                {remaining === 0 ? 'done' : formatRemaining(remaining)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
