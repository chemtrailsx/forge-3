import type {
  ConversationTurn,
  CookingSession,
  Ingredient,
  MemoryEntry,
  Recipe,
  RecipeStep,
  SessionNotes,
  TimerRecord,
} from '../types';
import {
  ingredientsSchema,
  parseOrDefault,
  sessionNotesSchema,
  stepsSchema,
} from '../validation';

/**
 * Row shapes as Postgres returns them, plus the mappers into domain types.
 *
 * JSONB columns are validated on the way out, not trusted: a row written by an
 * older version of the app must degrade to an empty list rather than crash a
 * cooking session mid-recipe.
 */

export type RecipeRow = {
  id: string;
  user_id: string;
  title: string;
  ingredients: unknown;
  steps: unknown;
  servings: number;
  is_favorite: boolean;
  source: string | null;
  created_at: string;
};

export const RECIPE_COLUMNS =
  'id, user_id, title, ingredients, steps, servings, is_favorite, source, created_at';

export function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    ingredients: parseOrDefault(ingredientsSchema, row.ingredients, [] as Ingredient[]),
    steps: parseOrDefault(stepsSchema, row.steps, [] as RecipeStep[]),
    servings: row.servings,
    isFavorite: row.is_favorite,
    source: row.source,
    createdAt: row.created_at,
  };
}

export type SessionRow = {
  id: string;
  user_id: string;
  recipe_id: string | null;
  current_step: number;
  status: string;
  notes: unknown;
  created_at: string;
  updated_at: string;
};

export const SESSION_COLUMNS =
  'id, user_id, recipe_id, current_step, status, notes, created_at, updated_at';

export function toSession(row: SessionRow): CookingSession {
  const status: CookingSession['status'] =
    row.status === 'paused' || row.status === 'finished' ? row.status : 'active';
  return {
    id: row.id,
    userId: row.user_id,
    recipeId: row.recipe_id,
    currentStep: row.current_step,
    status,
    notes: parseOrDefault(sessionNotesSchema, row.notes, {} as SessionNotes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type MemoryRow = {
  id: string;
  key: string;
  value: string;
  kind: string;
  updated_at: string;
};

export const MEMORY_COLUMNS = 'id, key, value, kind, updated_at';

export function toMemory(row: MemoryRow): MemoryEntry {
  const kind = row.kind as MemoryEntry['kind'];
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    kind: ['preference', 'avoidance', 'note', 'observation'].includes(kind) ? kind : 'note',
    updatedAt: row.updated_at,
  };
}

export type TimerRow = {
  id: string;
  label: string;
  duration_ms: number;
  started_at: string;
  status: string;
  kind?: string | null;
  step_index?: number | null;
  heads_up_at?: string | null;
  reminded_at?: string | null;
};

export const TIMER_COLUMNS =
  'id, label, duration_ms, started_at, status, kind, step_index, heads_up_at, reminded_at';

export function toTimer(row: TimerRow): TimerRecord {
  const status: TimerRecord['status'] =
    row.status === 'cancelled' || row.status === 'completed' ? row.status : 'running';
  return {
    id: row.id,
    label: row.label,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    status,
    kind: row.kind === 'step' ? 'step' : 'timer',
    stepIndex: row.step_index ?? null,
    headsUpAt: row.heads_up_at ?? null,
    remindedAt: row.reminded_at ?? null,
  };
}

export type TurnRow = {
  id: string;
  turn_index: number;
  role: string;
  text: string;
  heard_text: string | null;
  interrupted: boolean;
  created_at: string;
};

export const TURN_COLUMNS = 'id, turn_index, role, text, heard_text, interrupted, created_at';

export function toTurn(row: TurnRow): ConversationTurn {
  return {
    id: row.id,
    turnIndex: row.turn_index,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    text: row.text,
    heardText: row.heard_text,
    interrupted: row.interrupted,
    createdAt: row.created_at,
  };
}
