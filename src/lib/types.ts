/** Shared domain types. Database row shapes live in `lib/db/schema.ts`. */

export type Ingredient = {
  name: string;
  quantity: number | null;
  unit: string | null;
  note?: string | null;
};

export type Recipe = {
  id: string;
  userId: string;
  title: string;
  ingredients: Ingredient[];
  steps: string[];
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
  servings: number;
  baseServings: number;
  ingredients: Ingredient[];
  substitutions: Substitution[];
  timers: TimerView[];
  corrections: string[];
};
