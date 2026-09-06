import { providerDescriptors } from '@/lib/env';

/**
 * Which providers are configured, without saying anything about their keys.
 *
 * The cooking screen shows this so a missing key surfaces as "TTS not
 * configured" rather than as silence the user has to debug by ear.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, providers: providerDescriptors() });
}
