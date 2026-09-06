'use client';

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '../env';

/**
 * Browser Supabase client. Anon key only — it is safe there precisely because
 * RLS (supabase/migrations/0002_rls.sql) is the authority on what any given
 * token may read. The browser never sees a service-role key.
 */
export function createClient() {
  const env = publicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
