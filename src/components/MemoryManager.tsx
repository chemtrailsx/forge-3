'use client';

import { useState } from 'react';
import type { MemoryEntry } from '@/lib/types';

/**
 * The user's view of what is remembered about them, with a delete on every row.
 *
 * A persistent memory the user cannot inspect or remove is not a feature, it is
 * a liability — the assistant will keep acting on a preference they no longer
 * hold and they will have no way to tell it otherwise.
 */
export function MemoryManager({ initial }: { initial: MemoryEntry[] }) {
  const [entries, setEntries] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/memory/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setEntries((current) => current.filter((entry) => entry.id !== id));
    } catch {
      setError('Could not delete that memory.');
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    setBusy('all');
    setError(null);
    try {
      const response = await fetch('/api/memory', { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setEntries([]);
    } catch {
      setError('Could not clear your memory.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>What the assistant remembers</h3>
        {entries.length > 0 ? (
          <button className="ghost danger small" onClick={removeAll} disabled={busy === 'all'}>
            Forget everything
          </button>
        ) : null}
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {entries.length === 0 ? (
        <p className="muted small" style={{ marginTop: 10 }}>
          Nothing saved yet. Say something like &ldquo;I usually cook for four&rdquo; or &ldquo;I
          don&rsquo;t like very spicy food&rdquo; while cooking.
        </p>
      ) : (
        <ul className="plain" style={{ marginTop: 12 }}>
          {entries.map((entry) => (
            <li key={entry.id}>
              <div>
                <div>{entry.value}</div>
                <span className="muted small">
                  {entry.key.replace(/_/g, ' ')} · {entry.kind}
                </span>
              </div>
              <button
                className="ghost danger small"
                onClick={() => remove(entry.id)}
                disabled={busy === entry.id}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
