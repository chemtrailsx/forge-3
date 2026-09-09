'use client';

import { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '@/lib/voice/voice-client';

/** Within this much of the bottom counts as "following the conversation". */
const FOLLOW_THRESHOLD_PX = 120;

export function TranscriptFeed({ entries }: { entries: TranscriptEntry[] }) {
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * Keep the newest message in view by scrolling the feed itself.
   *
   * This used to call `scrollIntoView` on an anchor at the end of the list,
   * which does not confine itself to the scrollable box — it walks up and
   * scrolls every ancestor, the window included. So every single thing the
   * cook said yanked the whole page, which is unusable when the thing you are
   * looking at is the step above.
   *
   * It also stops following when the cook has scrolled up to read something.
   * Dragging them back to the bottom mid-sentence is the same rudeness in a
   * smaller form.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom > FOLLOW_THRESHOLD_PX) return;

    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [entries]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div className="section-label">Live Feed</div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)', textTransform: 'none' }}>
            Conversation
          </h3>
        </div>
        <span className="badge">{entries.length} messages</span>
      </div>

      <div className="transcript-box" ref={listRef} style={{ flex: 1 }}>
        {entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-3)' }}>
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
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </div>
            <p className="small" style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>
              Speak naturally to begin
            </p>
            <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
              Tell your companion what you are cooking or what ingredients you have
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`bubble ${entry.role}`}>
              <div className="who">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {entry.role === 'user' ? (
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: 'var(--surface-3)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-2)',
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </span>
                  ) : (
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: 'var(--accent-quiet)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--accent)',
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z" />
                      </svg>
                    </span>
                  )}
                  <span style={{ fontWeight: 700, color: entry.role === 'user' ? 'var(--text-2)' : 'var(--accent)' }}>
                    {entry.role === 'user' ? 'You' : 'Companion'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {entry.profile && entry.profile !== 'normal' ? (
                    <span className="badge" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                      {entry.profile}
                    </span>
                  ) : null}
                  {entry.interrupted ? (
                    <span style={{ color: 'var(--danger)', fontSize: '0.72rem', fontStyle: 'italic' }}>
                      cut off
                    </span>
                  ) : null}
                  {/* So a repeat does not read as the assistant saying something new. */}
                  {entry.replay ? (
                    <span style={{ color: 'var(--text-2)', fontSize: '0.72rem', fontStyle: 'italic' }}>
                      replay
                    </span>
                  ) : null}
                </div>
              </div>
              <div style={{ lineHeight: 1.5, color: 'var(--text)' }}>{entry.text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
