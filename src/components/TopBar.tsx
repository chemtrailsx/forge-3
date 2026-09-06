import Link from 'next/link';

export function TopBar({ email, current }: { email: string | null; current: 'cook' | 'profile' }) {
  return (
    <header className="topbar">
      <Link href="/dashboard" style={{ color: 'var(--text)', fontWeight: 640 }}>
        Cooking Companion
      </Link>
      <nav>
        {current === 'profile' ? (
          <Link href="/dashboard">Kitchen</Link>
        ) : (
          <Link href="/profile">Preferences &amp; memory</Link>
        )}
        <span className="muted small">{email}</span>
        <form action="/auth/signout" method="post">
          <button className="ghost small" type="submit">
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}
