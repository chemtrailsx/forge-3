'use client';

import { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '@/lib/voice/voice-client';

export function TranscriptFeed({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  return (
    <section className="card">
      <h3>Transcript</h3>
      <div className="transcript">
        {entries.length === 0 ? (
          <p className="muted small">Say something to begin.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`bubble ${entry.role}`}>
              <div className="who">
                {entry.role === 'user' ? 'You' : 'Companion'}
                {entry.profile && entry.profile !== 'normal' ? ` · ${entry.profile}` : ''}
                {entry.interrupted ? ' · cut off' : ''}
              </div>
              {entry.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
