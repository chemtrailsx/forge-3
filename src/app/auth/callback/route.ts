import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Email confirmation / magic-link landing.
 *
 * Supabase redirects here with a one-time code, which is exchanged for a
 * session cookie server-side so the token never sits in browser history.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/dashboard';

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=invalid_code', url.origin));
  }

  return NextResponse.redirect(new URL(next.startsWith('/') ? next : '/dashboard', url.origin));
}
