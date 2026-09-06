import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { deleteMemory } from '@/lib/db/memory';
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
    await deleteMemory(dbFor(ctx), parseOrThrow(uuidSchema, id, 'memory id'));
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
