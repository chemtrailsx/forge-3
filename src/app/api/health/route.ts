import { getUserContext } from '@/lib/auth/session';
import { providerDescriptors } from '@/lib/env';

/**
 * Liveness, plus — for a signed-in user — which providers are configured.
 *
 * The split matters. A deploy platform needs an unauthenticated probe, but
 * which model and endpoint this instance talks to is configuration detail that
 * anonymous callers have no reason to enumerate. So the probe is public and the
 * detail is not.
 *
 * Nothing here ever reveals a key; `providerDescriptors()` reports only whether
 * one is present.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ctx = await getUserContext();
  if (!ctx) return Response.json({ ok: true });

  return Response.json({ ok: true, providers: providerDescriptors() });
}
