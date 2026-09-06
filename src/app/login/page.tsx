import { LoginForm } from '@/components/LoginForm';
import { publicEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

function isConfigured(): boolean {
  try {
    publicEnv();
    return true;
  } catch {
    return false;
  }
}

export default function LoginPage() {
  const configured = isConfigured();

  return (
    <main className="page narrow">
      <h1>Cooking Companion</h1>
      <p className="muted">
        A voice-first cooking assistant. Your recipes, cooking history and preferences are yours
        alone.
      </p>

      <div className="card" style={{ marginTop: 24 }}>
        {configured ? (
          <LoginForm />
        ) : (
          <>
            <h2>Set up required</h2>
            <p className="muted small">
              Supabase is not configured, so there is nothing to sign in to yet. Copy{' '}
              <code>.env.example</code> to <code>.env.local</code>, fill in{' '}
              <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
              run the migrations in <code>supabase/migrations</code>, then restart the dev server.
            </p>
            <p className="muted small" style={{ marginBottom: 0 }}>
              See the README for the full checklist.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
