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

    const provider = getSttProvider();
    const text = await provider.transcribe(audio, request.signal);

    return Response.json({ text, model: provider.model });
  } catch (error) {
    return toErrorResponse(error);
  }
}
