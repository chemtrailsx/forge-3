import { createClient } from '@supabase/supabase-js';
import { publicEnv, serviceRoleKey } from '../env';

/**
 * Service-role client. Bypasses RLS entirely, so it is confined to offline
 * scripts (`npm run seed`, `npm run verify:rls`) and is never imported by a
 * route handler or a component.
 *
 * Note the guard below rather than the `server-only` package. `server-only`
 * resolves to a module that throws outside a bundler, which breaks the plain
 * `tsx` scripts that are this module's only legitimate consumers — it would be
 * protecting a boundary nothing crosses while blocking the one that matters.
 * An explicit runtime check does the real job: if this ever reaches a browser,
 * it fails loudly instead of shipping a key.
 */
export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'The Supabase service-role client must never run in a browser. ' +
        'Something imported lib/supabase/admin into client code.',
    );
  }

  const env = publicEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
