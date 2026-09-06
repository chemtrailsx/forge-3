import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { deleteAllMemory, listMemory, saveMemory } from '@/lib/db/memory';
import { toErrorResponse } from '@/lib/errors';
import { memoryInputSchema, parseOrThrow } from '@/lib/validation';

/**
 * The user's view of what the assistant remembers about them.
 *
 * Required by the spec ("users must be able to view/delete persistent
 * information") and load-bearing for trust: a memory the user cannot see is a
 * memory they cannot correct.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const ctx = await requireUser();
    const memory = await listMemory(dbFor(ctx));
    return Response.json({ memory });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const input = parseOrThrow(memoryInputSchema, await request.json(), 'memory');
    const entry = await saveMemory(dbFor(ctx), input.key, input.value, input.kind);
    return Response.json({ entry }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const ctx = await requireUser();
    await deleteAllMemory(dbFor(ctx));
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
