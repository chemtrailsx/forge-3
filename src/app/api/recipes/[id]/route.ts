import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { deleteRecipe, getRecipe, setFavorite } from '@/lib/db/recipes';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const recipe = await getRecipe(dbFor(ctx), parseOrThrow(uuidSchema, id, 'recipe id'));
    if (!recipe) throw new NotFoundError('Recipe');
    return Response.json({ recipe });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const body = parseOrThrow(
      z.object({ isFavorite: z.boolean() }),
      await request.json(),
      'recipe update',
    );
    await setFavorite(dbFor(ctx), parseOrThrow(uuidSchema, id, 'recipe id'), body.isFavorite);
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    await deleteRecipe(dbFor(ctx), parseOrThrow(uuidSchema, id, 'recipe id'));
    return Response.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
