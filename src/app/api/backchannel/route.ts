import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireUser } from '@/lib/auth/session';
import { toErrorResponse } from '@/lib/errors';
import { getTtsProvider } from '@/lib/tts';
import { PROFILES } from '@/lib/tts/speech-profile';
import { pickBackchannel } from '@/lib/voice/backchannel';
import { parseOrThrow } from '@/lib/validation';

/**
 * A backchannel — "mm-hm" — played while the user is still speaking.
 *
 * Deliberately its own endpoint rather than part of a turn: it must not create
 * a turn, must not touch cooking state, and must not be cancellable by the
 * barge-in logic, because it happens *during* the user's turn rather than
 * against it. The client decides when (see lib/voice/backchannel.ts); the
 * server only renders it.
 *
 * Returns raw PCM so the browser plays it through the same audio path as
 * everything else, at a lower gain.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ index: z.number().int().min(0).max(1000).default(0) });

export async function POST(request: Request): Promise<Response> {
  try {
    await requireUser();
    const body = parseOrThrow(bodySchema, await request.json().catch(() => ({})), 'backchannel');

    const tts = getTtsProvider();
    const phrase = pickBackchannel(body.index);
    const chunks: Buffer[] = [];

    for await (const event of tts.speak(
      { text: phrase, contextId: randomUUID(), profile: PROFILES.quick },
      request.signal,
    )) {
      if (event.type === 'audio') chunks.push(event.pcm);
    }

    const pcm = Buffer.concat(chunks);
    return new Response(new Uint8Array(pcm), {
      headers: {
        'Content-Type': 'audio/L16',
        'X-Sample-Rate': String(tts.samplingRate),
        'X-Phrase': encodeURIComponent(phrase),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
