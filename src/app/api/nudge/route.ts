import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireUser } from '@/lib/auth/session';
import { loadCookingState } from '@/lib/cooking/state';
import { dbFor } from '@/lib/db/context';
import { listActiveTimers, markAnnounced } from '@/lib/db/timers';
import { nextTurnIndex, recordTurn } from '@/lib/db/turns';
import { toErrorResponse } from '@/lib/errors';
import { getTtsProvider } from '@/lib/tts';
import { PROFILES } from '@/lib/tts/speech-profile';
import { toSpeakable } from '@/lib/tts/speakable';
import { parseOrThrow } from '@/lib/validation';
import { selectNudge } from '@/lib/voice/nudge';

/**
 * The only place the assistant speaks without being spoken to.
 *
 * The browser polls this while a session is open; the server decides whether
 * anything is worth saying and, if so, returns the audio to play. Polling
 * rather than a held-open stream because a reminder is worth at most a few
 * seconds of latency, and a persistent connection per cook would have to
 * survive route timeouts, sleeping laptops and reconnects to buy nothing a
 * kitchen would notice.
 *
 * The decision is made server-side, against the database, so it holds across a
 * reload and cannot be duplicated by two open tabs: whichever asks first marks
 * the timer announced, and the other is told there is nothing to say.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  /** The client knows these; the server must not talk over either. */
  assistantSpeaking: z.boolean().default(false),
  userSpeaking: z.boolean().default(false),
  msSinceLastNudge: z.number().min(0).max(3_600_000).nullable().default(null),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const db = dbFor(ctx);
    const body = parseOrThrow(bodySchema, await request.json(), 'nudge request');

    const state = await loadCookingState(db, body.sessionId);
    const timers = await listActiveTimers(db, body.sessionId);

    const nudge = selectNudge({
      state: state.snapshot,
      timers,
      assistantSpeaking: body.assistantSpeaking,
      userSpeaking: body.userSpeaking,
      msSinceLastNudge: body.msSinceLastNudge,
    });

    if (!nudge) return Response.json({ speak: null });

    // Claimed before the audio is synthesised. If synthesis fails the cook
    // misses one reminder; if this ran afterwards, a slow Rime call would let
    // the next poll announce the same pasta again.
    await markAnnounced(db, nudge.timerId, nudge.reason);

    const tts = getTtsProvider();
    const contextId = randomUUID();
    const chunks: Buffer[] = [];

    for await (const event of tts.speak(
      {
        text: toSpeakable(nudge.text, { precise: true }),
        contextId,
        profile: PROFILES[nudge.profile],
      },
      request.signal,
    )) {
      if (event.type === 'audio') chunks.push(event.pcm);
    }

    // Recorded as a turn so the conversation stays coherent: the cook may well
    // answer it ("no, give it another minute"), and the model needs to know
    // what it just said.
    const turnIndex = await nextTurnIndex(db, body.sessionId);
    await recordTurn(db, {
      sessionId: body.sessionId,
      turnIndex,
      role: 'assistant',
      text: nudge.text,
      metrics: { unprompted: true, reason: nudge.reason },
    });

    return Response.json({
      speak: {
        text: nudge.text,
        reason: nudge.reason,
        contextId,
        turnIndex,
        pcm: Buffer.concat(chunks).toString('base64'),
        sampleRate: tts.samplingRate,
      },
      state: state.snapshot,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
