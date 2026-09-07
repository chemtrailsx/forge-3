import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Pages only.
     *
     * Excluded: static assets, and the audio worklets, which the AudioContext
     * fetches without credentials.
     *
     * Also excluded — deliberately — is `/api`. The middleware's two jobs there
     * were refreshing the session cookie and turning away anonymous callers,
     * and both already happen inside the route: every handler begins with
     * `requireUser()`, which validates the JWT with the auth server and, in a
     * route handler (unlike a server component) can write the refreshed cookie
     * back. Running it here as well made every API call ask the auth server the
     * same question twice — about three hundred milliseconds of the wait
     * between a cook finishing a sentence and hearing a reply.
     *
     * This is not a relaxation of the auth boundary: no API route becomes
     * reachable without a verified session, and `tests/data-isolation.test.ts`
     * asserts that every route file still authenticates for itself, so a new
     * route cannot quietly rely on a gate that no longer runs.
     */
    '/((?!api|_next/static|_next/image|worklets|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
