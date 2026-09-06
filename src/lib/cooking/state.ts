import { getRecipe } from '../db/recipes';
import { getSession, updateSession, type SessionPatch } from '../db/sessions';
import { listActiveTimers, reapExpiredTimers } from '../db/timers';
import type { Db } from '../db/context';
import { NotFoundError } from '../errors';
import type { CookingSession, CookingStateSnapshot, Recipe, Substitution } from '../types';
import { scaleIngredients } from './scale';

/**
 * Assembles the live cooking state.
 *
 * This is the object that makes the assistant a companion rather than a
 * sequence of isolated voice queries: "what's next", "how much of that", and
 * "I'm out of butter" are all answerable only against it. It is rebuilt per
 * turn from the database rather than cached in a process, because the same
 * session must survive a page reload, a second device, and a server restart.
 */

export type LoadedState = {
  session: CookingSession;
  recipe: Recipe | null;
  snapshot: CookingStateSnapshot;
};

export async function loadCookingState(db: Db, sessionId: string): Promise<LoadedState> {
  const session = await getSession(db, sessionId);
  if (!session) throw new NotFoundError('Cooking session');

  const recipe = session.recipeId ? await getRecipe(db, session.recipeId) : null;

  const timers = await listActiveTimers(db, session.id);
  // Expired timers are retired on read: nothing else is guaranteed to run.
  await reapExpiredTimers(db, timers);

  return {
    session,
    recipe,
    snapshot: buildSnapshot(session, recipe, timers.filter((t) => !t.expired)),
  };
}

export function buildSnapshot(
  session: CookingSession,
  recipe: Recipe | null,
  timers: CookingStateSnapshot['timers'],
): CookingStateSnapshot {
  const baseServings = recipe?.servings ?? 2;
  const servings = session.notes.servings ?? baseServings;
  const steps = recipe?.steps ?? [];
  const step = clampStep(session.currentStep, steps.length);

  const ingredients =
    recipe && servings !== baseServings
      ? scaleIngredients(recipe.ingredients, baseServings, servings)
      : (recipe?.ingredients ?? []);

  return {
    sessionId: session.id,
    recipeId: session.recipeId,
    title: recipe?.title ?? 'Untitled session',
    currentStep: step,
    totalSteps: steps.length,
    currentStepText: steps[step] ?? null,
    nextStepText: steps[step + 1] ?? null,
    servings,
    baseServings,
    ingredients,
    substitutions: session.notes.substitutions ?? [],
    timers,
    corrections: session.notes.corrections ?? [],
  };
}

export function clampStep(step: number, totalSteps: number): number {
  if (totalSteps === 0) return 0;
  return Math.min(Math.max(0, Math.trunc(step)), totalSteps - 1);
}

/** Move the cook forward/back or to an absolute step, clamped to the recipe. */
export async function moveToStep(
  db: Db,
  state: LoadedState,
  target: number,
): Promise<CookingSession> {
  const next = clampStep(target, state.snapshot.totalSteps);
  const updated = await updateSession(db, state.session.id, { currentStep: next });
  return updated ?? state.session;
}

export async function setServings(
  db: Db,
  state: LoadedState,
  servings: number,
): Promise<CookingSession> {
  const notes = { ...state.session.notes, servings };
  const updated = await updateSession(db, state.session.id, { notes });
  return updated ?? state.session;
}

export async function recordSubstitution(
  db: Db,
  state: LoadedState,
  substitution: Substitution,
): Promise<CookingSession> {
  const existing = state.session.notes.substitutions ?? [];
  const deduped = existing.filter(
    (s) => s.from.toLowerCase() !== substitution.from.toLowerCase(),
  );
  const notes = { ...state.session.notes, substitutions: [...deduped, substitution].slice(-20) };
  const updated = await updateSession(db, state.session.id, { notes });
  return updated ?? state.session;
}

/**
 * A correction is what the user said when they cut the assistant off. Keeping
 * the last few in session state is what lets the next response acknowledge the
 * fix ("Right — add the salt first") instead of restarting the sentence that
 * was interrupted.
 */
export async function recordCorrection(
  db: Db,
  state: LoadedState,
  correction: string,
): Promise<CookingSession> {
  const trimmed = correction.trim().slice(0, 300);
  if (!trimmed) return state.session;
  const corrections = [...(state.session.notes.corrections ?? []), trimmed].slice(-5);
  const updated = await updateSession(db, state.session.id, {
    notes: { ...state.session.notes, corrections },
  });
  return updated ?? state.session;
}

export async function patchSession(
  db: Db,
  sessionId: string,
  patch: SessionPatch,
): Promise<CookingSession | null> {
  return updateSession(db, sessionId, patch);
}
