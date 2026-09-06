import { requireUser } from '@/lib/auth/session';
import { cancelTimer } from '@/lib/db/timers';
import { dbFor } from '@/lib/db/context';
import { toErrorResponse } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    await cancelTimer(dbFor(ctx), parseOrThrow(uuidSchema, id, 'timer id'));
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
