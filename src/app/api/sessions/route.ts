import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { getRecipe } from '@/lib/db/recipes';
import { createSession, listSessions } from '@/lib/db/sessions';
import { getProfile } from '@/lib/db/profiles';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  recipeId: z.string().uuid(),
  servings: z.number().int().min(1).max(50).optional(),
});

export async function GET(): Promise<Response> {
  try {
    const ctx = await requireUser();
    const sessions = await listSessions(dbFor(ctx), 20);
    return Response.json({ sessions });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireUser();
    const db = dbFor(ctx);
    const body = parseOrThrow(createSchema, await request.json(), 'session');

    // Ownership is checked here as well as by the database trigger, so the
    // caller gets a 404 rather than a raw constraint violation.
    const recipe = await getRecipe(db, body.recipeId);
    if (!recipe) throw new NotFoundError('Recipe');

    // "I usually cook for four" applies without being restated every time.
    const profile = await getProfile(db);
    const servings = body.servings ?? profile?.preferences.defaultServings;

    const session = await createSession(
      db,
      recipe.id,
      servings && servings !== recipe.servings ? { servings } : {},
    );
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
