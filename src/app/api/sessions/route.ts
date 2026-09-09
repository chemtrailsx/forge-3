import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { dbFor } from '@/lib/db/context';
import { getRecipe } from '@/lib/db/recipes';
import { createSession, listSessions } from '@/lib/db/sessions';
import { getProfile, updatePreferences } from '@/lib/db/profiles';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `recipeId` is optional: a session can start empty, before the cook has said
 * what they are making. That is the normal way in — you open the app and talk —
 * and `plan_recipe` fills the session in from what they say.
 */
const createSchema = z.object({
  recipeId: z.string().uuid().nullable().optional(),
  servings: z.number().int().min(1).max(50).optional(),
  /**
   * Where the browser thinks the cook is, as an ISO country code.
   *
   * Recorded once, on the first session that reports it, and never
   * overwritten — a stated preference beats a guess from a locale, and someone
   * travelling should not have their kitchen relocated by an airport wifi.
   */
  region: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
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

    // "I usually cook for four" applies without being restated every time.
    const profile = await getProfile(db);
    const servings = body.servings ?? profile?.preferences.defaultServings;

    // Learned silently on first use rather than asked for. Only filled if
    // absent, so anything the cook has actually told us wins.
    //
    // Started, not awaited: nothing in the response depends on it, and this is
    // the button someone presses when they want to start cooking now.
    if (body.region && !profile?.preferences.region) {
      void updatePreferences(db, { region: body.region.toUpperCase() }).catch((error: unknown) => {
        console.error('[api/sessions] could not record region', error);
      });
    }

    if (!body.recipeId) {
      // An empty session. The cook says what they want and plan_recipe writes
      // it; carrying their usual serving count in means they do not have to.
      const session = await createSession(db, null, servings ? { servings } : {});
      return Response.json({ session }, { status: 201 });
    }

    // Ownership is checked here as well as by the database trigger, so the
    // caller gets a 404 rather than a raw constraint violation.
    const recipe = await getRecipe(db, body.recipeId);
    if (!recipe) throw new NotFoundError('Recipe');

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
