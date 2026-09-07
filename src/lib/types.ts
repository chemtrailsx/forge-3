/** Shared domain types. Database row shapes live in `lib/db/schema.ts`. */

export type Ingredient = {
  name: string;
  quantity: number | null;
  unit: string | null;
  note?: string | null;
};

/**
 * One instruction, plus what the cook can do while it happens.
 *
 * `attention` is the field that makes parallel cooking possible. A step that
 * runs by itself — water coming to a boil, a sauce reducing, a chicken in the
 * oven — leaves the cook's hands free, and an assistant that does not know
 * that will march them through the recipe one blocking step at a time. It is
 * also what tells the assistant when it should come back unprompted, since an
 * unattended step is exactly the one nobody is watching.
 */
export type RecipeStep = {
  text: string;
  /** How long it runs unattended. Null for a step that finishes when you stop. */
  durationSeconds: number | null;
  attention: 'active' | 'passive';
};

export type Recipe = {
  id: string;
  userId: string;
  title: string;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  servings: number;
  isFavorite: boolean;
  source: string | null;
  createdAt: string;
};

export type Substitution = {
  from: string;
  to: string;
  note: string;
};

export type SessionNotes = {
  /** Servings the user is actually cooking for, if it differs from the recipe. */
  servings?: number;
  substitutions?: Substitution[];
  /** Short user corrections, newest last. Kept small on purpose. */
  corrections?: string[];
  scratch?: string[];
};

export type CookingSession = {
  id: string;
  userId: string;
  recipeId: string | null;
  currentStep: number;
  status: 'active' | 'paused' | 'finished';
  notes: SessionNotes;
  createdAt: string;
  updatedAt: string;
};

export type MemoryKind = 'preference' | 'avoidance' | 'note' | 'observation';

export type MemoryEntry = {
  id: string;
  key: string;
  value: string;
  kind: MemoryKind;
  updatedAt: string;
};

export type TimerRecord = {
  id: string;
  label: string;
  durationMs: number;
  startedAt: string;
  status: 'running' | 'cancelled' | 'completed';
  /**
   * `timer` is one the cook asked for. `step` is one the assistant started on
   * their behalf when an unattended step began — the pasta going into the
   * water. Both count down identically; they differ in how they are announced,
   * because "your timer is up" and "the pasta should be done" are different
   * sentences.
   */
  kind: 'timer' | 'step';
  /** The step this belongs to, for a `step` timer. */
  stepIndex: number | null;
  /** When the assistant gave a "nearly done" warning, so it gives one only. */
  headsUpAt: string | null;
  /** When the assistant announced it finished, so it announces it once. */
  remindedAt: string | null;
};

export type TimerView = TimerRecord & {
  remainingMs: number;
  expired: boolean;
};

export type ConversationTurn = {
  id: string;
  turnIndex: number;
  role: 'user' | 'assistant';
  text: string;
  heardText: string | null;
  interrupted: boolean;
  createdAt: string;
};

/**
 * Everything the orchestrator needs to know about "where the cook is right
 * now". Sent to the UI verbatim and summarised into the LLM prompt.
 */
export type CookingStateSnapshot = {
  sessionId: string;
  recipeId: string | null;
  title: string;
  currentStep: number;
  totalSteps: number;
  currentStepText: string | null;
  nextStepText: string | null;
  /** The current step in full, including whether it needs hands. */
  currentStepDetail: RecipeStep | null;
  nextStepDetail: RecipeStep | null;
  servings: number;
  baseServings: number;
  ingredients: Ingredient[];
  substitutions: Substitution[];
  /**
   * Everything counting down right now — the pasta boiling while the cook
   * chops, and any timer they set themselves.
   *
   * One list rather than two. The distinction between "the assistant started
   * this when you reached a passive step" and "you asked for this" matters for
   * how a reminder is *phrased*, and for nothing else: either way it is work
   * happening that nobody is watching. Splitting them meant a timer the cook
   * asked for showed up nowhere, which is how it was first built and how it
   * was wrong.
   */
  timers: TimerView[];
  corrections: string[];
  /** True before a dish has been chosen, so the UI can invite one. */
  awaitingRecipe: boolean;
};
