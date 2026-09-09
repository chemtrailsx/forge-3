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
    <main
      className="page narrow"
      style={{
        minHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '32px 20px',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'var(--accent-quiet)',
            color: 'var(--accent)',
            border: '1px solid var(--border)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z" />
          </svg>
        </div>
        <h1 style={{ fontSize: '1.85rem', marginBottom: 8, letterSpacing: '-0.03em', color: 'var(--text)' }}>
          Cooking Companion
        </h1>
        <p className="muted" style={{ maxWidth: 360, margin: '0 auto', fontSize: '0.9rem', lineHeight: 1.5 }}>
          Your hands-free, real-time voice culinary guide.
        </p>
      </div>

      <div
        className="card"
        style={{
          background: '#FFFFFF',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-md)',
          borderRadius: 'var(--radius-lg)',
          padding: '32px 28px',
        }}
      >
        {configured ? (
          <LoginForm />
        ) : (
          <>
            <h2>Setup required</h2>
            <p className="muted small">
              Supabase is not configured yet. Copy <code>.env.example</code> to <code>.env.local</code> and fill in credentials.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
