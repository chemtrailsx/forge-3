import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { publicEnv, serviceRoleKey } from '../env';

/**
 * Service-role client. Bypasses RLS, so it is confined to offline scripts
 * (`npm run seed`) and never imported by a route handler or a component.
 *
 * The `server-only` import above turns an accidental client import into a
 * build error rather than a leaked key.
 */
export function createAdminClient() {
  const env = publicEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
