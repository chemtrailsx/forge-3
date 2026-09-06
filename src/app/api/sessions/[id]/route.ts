import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { loadCookingState } from '@/lib/cooking/state';
import { dbFor } from '@/lib/db/context';
import { deleteSession, updateSession } from '@/lib/db/sessions';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  currentStep: z.number().int().min(0).max(500).optional(),
  status: z.enum(['active', 'paused', 'finished']).optional(),
  servings: z.number().int().min(1).max(50).optional(),
});

/** The full cooking-state snapshot, for the UI and for state recovery. */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const state = await loadCookingState(dbFor(ctx), parseOrThrow(uuidSchema, id, 'session id'));
    return Response.json({ state: state.snapshot });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const db = dbFor(ctx);
    const { id } = await params;
    const sessionId = parseOrThrow(uuidSchema, id, 'session id');
    const body = parseOrThrow(patchSchema, await request.json(), 'session update');

    const state = await loadCookingState(db, sessionId);
    const notes =
      body.servings === undefined
        ? undefined
        : { ...state.session.notes, servings: body.servings };

    const updated = await updateSession(db, sessionId, {
      ...(body.currentStep === undefined ? {} : { currentStep: body.currentStep }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(notes === undefined ? {} : { notes }),
    });
    if (!updated) throw new NotFoundError('Cooking session');

    const refreshed = await loadCookingState(db, sessionId);
    return Response.json({ state: refreshed.snapshot });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    await deleteSession(dbFor(ctx), parseOrThrow(uuidSchema, id, 'session id'));
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
