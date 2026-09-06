import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { toErrorResponse } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';
import { encodeSse, type TurnEvent } from '@/lib/voice/events';
import { runTurn } from '@/lib/voice/orchestrator';

/**
 * One conversational turn, streamed as Server-Sent Events.
 *
 * Audio rides in this stream alongside the state and tool events, so a
 * barge-in is a single cancellation: the browser aborts this fetch, and the
 * abort propagates to Rime, the model and any in-flight tool at once. Splitting
 * audio onto a second request would leave one of them alive to speak over the
 * user's correction.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  transcript: z.string().trim().min(1).max(2000),
  /** Present when this turn is a correction that cut the assistant off. */
  interruption: z
    .object({
      turnIndex: z.number().int().min(0),
      heardText: z.string().max(4000),
      latencyMs: z.number().min(0).max(60000),
    })
    .nullable()
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const body = parseOrThrow(bodySchema, await request.json(), 'turn request');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: TurnEvent) => controller.enqueue(encoder.encode(encodeSse(event)));

        try {
          for await (const event of runTurn({
            db: dbFor(ctx),
            sessionId: body.sessionId,
            utterance: body.transcript,
            interruption: body.interruption ?? null,
            // The request's own signal. Aborts when the browser cancels, which
            // is exactly what a barge-in does.
            signal: request.signal,
          })) {
            send(event);
          }
        } catch (error) {
          // The client going away is the expected end of an interrupted turn,
          // not a failure worth reporting.
          if (!request.signal.aborted) {
            console.error('[api/turn]', error);
            try {
              send({
                type: 'error',
                message: 'The assistant stopped unexpectedly. Try that again.',
              });
            } catch {
              // Stream already closed.
            }
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the cancellation.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx and friends buffer by default, which would hold audio chunks
        // back until the turn ends and defeat the whole design.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
