import { requireUser } from '@/lib/auth/session';
import { toErrorResponse, ValidationError } from '@/lib/errors';
import { getSttProvider } from '@/lib/stt/provider';

/**
 * Speech to text.
 *
 * Server-side so the STT key stays out of the browser. Authentication is
 * required even though the audio is not persisted: an unauthenticated
 * transcription endpoint is a free proxy to somebody else's API quota.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    await requireUser();

    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof Blob)) {
      throw new ValidationError('Expected an "audio" file field.');
    }

    /*
     * Words from the conversation already on the caller's screen, used to bias
     * recognition. Read as data and never trusted: it is capped, flattened to
     * one line, and only ever reaches the transcriber as a decoding hint, so
     * the worst a bad value can do is make recognition slightly worse for the
     * user who sent it.
     */
    const rawHint = form.get('hint');
    const hint =
      typeof rawHint === 'string' ? rawHint.replace(/\s+/g, ' ').trim().slice(0, 600) : undefined;

    const provider = getSttProvider();
    const text = await provider.transcribe(audio, request.signal, hint);

    return Response.json({ text, model: provider.model });
  } catch (error) {
    return toErrorResponse(error);
  }
}
