import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { createRecipe, listRecipes, searchRecipes } from '@/lib/db/recipes';
import { toErrorResponse } from '@/lib/errors';
import { parseOrThrow, recipeInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    const db = dbFor(ctx);
    const recipes = query ? await searchRecipes(db, query, 20) : await listRecipes(db);
    return Response.json({ recipes });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const input = parseOrThrow(recipeInputSchema, await request.json(), 'recipe');
    const recipe = await createRecipe(dbFor(ctx), input);
    return Response.json({ recipe }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
