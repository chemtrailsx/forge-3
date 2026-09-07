'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { detectRegion } from '@/lib/region';

/**
 * Creates a cooking session, then hands over to the voice screen.
 *
 * With no `recipeId` this starts an empty session — the ordinary way in, where
 * the cook opens the app and says what they feel like making. With one, it
 * resumes from something they already have.
 */
export function StartCookingButton({
  recipeId,
  label = 'Start cooking',
  variant = 'primary',
}: {
  recipeId?: string;
  label?: string;
  variant?: 'primary' | 'plain';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: recipeId ?? null, region: detectRegion() }),
      });
      const body = (await response.json()) as
        | { session: { id: string } }
        | { error: { message: string } };

      if (!response.ok || !('session' in body)) {
        setError('error' in body ? body.error.message : 'Could not start cooking.');
        setBusy(false);
        return;
      }
      router.push(`/cook/${body.session.id}`);
    } catch {
      setError('Could not start cooking.');
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <button className={variant === 'primary' ? 'primary' : ''} onClick={start} disabled={busy}>
        {busy ? 'Starting…' : label}
      </button>
      {error ? <span className="small" style={{ color: 'var(--danger)' }}>{error}</span> : null}
    </div>
  );
}
