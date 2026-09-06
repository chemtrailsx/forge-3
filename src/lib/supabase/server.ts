import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';

/** Shape @supabase/ssr hands back; typed locally rather than imported. */
type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

/**
 * Server Supabase client bound to the caller's session cookies.
 *
 * This is the client every route handler and server component uses. It carries
 * the *user's* JWT, so RLS applies to it exactly as it would in the browser —
 * server code gets no ambient privilege. That is deliberate: the server layer
 * and the database agree on who the caller is, and neither has to trust an id
 * the request body claims.
 */
export async function createServerSupabase() {
  const env = publicEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is expected.
        }
      },
    },
  });
}
