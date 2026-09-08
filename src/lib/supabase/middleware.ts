import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '../env';

/** Shape @supabase/ssr hands back; typed locally rather than imported. */
type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

/**
 * Paths reachable without a session. Everything else requires one.
 *
 * `/api/health` is here so a deploy platform can probe liveness without
 * credentials; the route itself withholds provider detail from anonymous
 * callers.
 */
const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout', '/api/health'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase session cookie on every request and gates private
 * routes.
 *
 * `getUser()` rather than `getSession()`: the former validates the JWT with
 * the auth server, the latter only decodes whatever cookie was presented.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  // Missing configuration fails *closed*: with no auth server to ask, nobody
  // is authenticated, so private routes stay shut and the login page explains
  // why. The alternative — a 500 on every request — hides the actual problem.
  let env;
  try {
    env = publicEnv();
  } catch {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'not_configured', message: 'Supabase is not configured.' } },
        { status: 503 },
      );
    }
    if (isPublic(pathname)) return response;
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '?setup=1';
    return NextResponse.redirect(url);
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { pathname } = request.nextUrl;

  /*
   * API routes authenticate themselves, in `requireUser()`, which validates the
   * JWT with the auth server and — in a route handler, unlike a server
   * component — can write the refreshed cookie back. Doing it here as well
   * meant every API call asked the same question twice, which is most of a
   * second in front of every spoken reply.
   *
   * The matcher in `src/middleware.ts` already keeps this function from running
   * for `/api` at all, so in normal operation this branch is never reached.
   * It stays as the second half of the same guarantee: if the matcher is ever
   * widened back, the cost does not quietly return with it.
   */
  if (pathname.startsWith('/api/')) {
    return response;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}
