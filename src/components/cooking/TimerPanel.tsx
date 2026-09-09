'use client';

import { useEffect, useState } from 'react';
import type { TimerView } from '@/lib/types';

export function TimerPanel({ timers }: { timers: TimerView[] }) {
  const [now, setNow] = useState<number | null>(null);
  const total = timers.length;

  useEffect(() => {
    if (total === 0) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [total]);

  if (total === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-3)' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 12,
            color: 'var(--accent)',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <p className="small" style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>
          No active timers
        </p>
        <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
          Say &ldquo;set a timer for eight minutes&rdquo; at any time while cooking.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="section-label">Kitchen Timers</div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)', textTransform: 'none' }}>
            Active Timers
          </h3>
        </div>
        <span className="badge on">
          {timers.length} {timers.length === 1 ? 'timer' : 'timers'}
        </span>
      </div>
      <ul className="plain">
        {timers.map((timer) => (
          <TimerRow key={timer.id} timer={timer} now={now} />
        ))}
      </ul>
    </div>
  );
}

function TimerRow({ timer, now }: { timer: TimerView; now: number | null }) {
  const endsAt = new Date(timer.startedAt).getTime() + timer.durationMs;
  const remaining = now === null ? timer.remainingMs : Math.max(0, endsAt - now);

  return (
    <li className={`timer-card${remaining > 0 ? ' running' : ''}`}>
      <div className="row" style={{ gap: 10 }}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke={remaining === 0 ? 'var(--danger)' : 'var(--accent)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span style={{ fontWeight: 600 }}>{timer.label}</span>
      </div>
      <span className={`timer-digits${remaining === 0 ? ' expired' : ''}`}>
        {remaining === 0 ? 'Ready' : formatRemaining(remaining)}
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
