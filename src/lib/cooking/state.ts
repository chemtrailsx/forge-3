import { getRecipe } from '../db/recipes';
import { getSession, updateSession, type SessionPatch } from '../db/sessions';
import { listActiveTimers, reapExpiredTimers, startTimer } from '../db/timers';
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
  // Only timers the cook has already been told about are retired here; an
  // expired-but-unannounced one is the trigger for a reminder and has to
  // survive until it has been spoken.
  await reapExpiredTimers(db, timers);

  return { session, recipe, snapshot: buildSnapshot(session, recipe, timers) };
}

export function buildSnapshot(
  session: CookingSession,
  recipe: Recipe | null,
  allTimers: CookingStateSnapshot['timers'],
): CookingStateSnapshot {
  const baseServings = recipe?.servings ?? 2;
  const servings = session.notes.servings ?? baseServings;
  const steps = recipe?.steps ?? [];
  const step = clampStep(session.currentStep, steps.length);

  const ingredients =
    recipe && servings !== baseServings
      ? scaleIngredients(recipe.ingredients, baseServings, servings)
      : (recipe?.ingredients ?? []);

  const live = allTimers.filter((timer) => !timer.expired);

  return {
    sessionId: session.id,
    recipeId: session.recipeId,
    title: recipe?.title ?? 'Untitled session',
    currentStep: step,
    totalSteps: steps.length,
    currentStepText: steps[step]?.text ?? null,
    nextStepText: steps[step + 1]?.text ?? null,
    currentStepDetail: steps[step] ?? null,
    nextStepDetail: steps[step + 1] ?? null,
    servings,
    baseServings,
    ingredients,
    substitutions: session.notes.substitutions ?? [],
    // Timers the cook set, separated from work the assistant is watching on
    // their behalf, because the two are described differently out loud.
    timers: live.filter((timer) => timer.kind === 'timer'),
    running: live.filter((timer) => timer.kind === 'step'),
    corrections: session.notes.corrections ?? [],
    awaitingRecipe: recipe === null,
  };
}

export function clampStep(step: number, totalSteps: number): number {
  if (totalSteps === 0) return 0;
  return Math.min(Math.max(0, Math.trunc(step)), totalSteps - 1);
}

/**
 * Move the cook forward/back or to an absolute step, clamped to the recipe.
 *
 * Arriving at an unattended step starts its clock automatically. That is the
 * whole basis of parallel cooking: nobody says "start a timer for the pasta",
 * they say "it's in" — and if the assistant waits to be asked, the thing it is
 * supposed to be watching is the thing nobody is watching.
 */
export async function moveToStep(
  db: Db,
  state: LoadedState,
  target: number,
): Promise<CookingSession> {
  const next = clampStep(target, state.snapshot.totalSteps);
  const updated = await updateSession(db, state.session.id, { currentStep: next });

  const step = state.recipe?.steps[next];
  if (step && step.attention === 'passive' && step.durationSeconds && step.durationSeconds > 0) {
    const alreadyRunning = state.snapshot.running.some((timer) => timer.stepIndex === next);
    if (!alreadyRunning) {
      await startTimer(db, {
        sessionId: state.session.id,
        durationMs: step.durationSeconds * 1000,
        label: describeStep(step.text),
        kind: 'step',
        stepIndex: next,
      });
    }
  }

  return updated ?? state.session;
}

/**
 * A short name for a step, for use in a spoken reminder.
 *
 * "Add the spaghetti and cook for eight minutes" has to come back as "the
 * spaghetti", because the reminder is "the spaghetti should be ready", not the
 * whole instruction read out a second time.
 */
export function describeStep(text: string): string {
  const cleaned = text
    .replace(/^(then\s+|now\s+)/i, '')
    // "for eight minutes" is the duration, not part of the thing's name.
    .replace(/\s+for\s+[\w\s-]*\b(seconds?|minutes?|hours?)\b.*$/i, '')
    .replace(/[.,;:].*$/, '')
    // "Add the spaghetti and cook" — the second clause is a further
    // instruction, and only the first names the thing being cooked.
    .split(/\s+\b(?:and|then|until|while)\b\s+/i)[0]
    ?.trim() ?? '';

  const words = cleaned.split(/\s+/).filter(Boolean);
  // Drop a leading imperative so the label reads as a thing, not an order.
  const withoutVerb = words.length > 2 ? words.slice(1) : words;

  // No article: the label is dropped into "Your ___ should be ready now", and
  // "Your the spaghetti" is the kind of sentence that makes a voice sound
  // broken even when the timing is perfect.
  const label = withoutVerb.join(' ').replace(/^(the|a|an|some|your)\s+/i, '');

  return (label || cleaned || 'that').slice(0, 60);
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
