import { z } from 'zod';
import { coerceIngredient } from './cooking/parse-ingredient';
import { ValidationError } from './errors';

/**
 * Every value that crosses a trust boundary — request bodies, tool arguments
 * produced by the model, JSONB read back from Postgres — is parsed here.
 *
 * Tool arguments matter as much as request bodies: an LLM emits plausible
 * JSON, not valid JSON, and `servings: "six"` should fail as a tool error the
 * model can retry, not as a NaN that silently scales a recipe to nothing.
 */

export const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().finite().nonnegative().nullable().default(null),
  unit: z.string().trim().max(30).nullable().default(null),
  note: z.string().trim().max(200).nullable().optional(),
});

/**
 * Ingredients may arrive as structured objects (from the API, or from a model
 * that manages it) or as spoken lines like "200 g spaghetti". Both are parsed
 * to the same shape, so nothing downstream has to care which arrived — see
 * `lib/cooking/parse-ingredient.ts` for why the spoken form is the one the
 * tool actually advertises.
 */
export const ingredientsSchema = z
  .array(z.union([z.string().trim().min(1).max(200), ingredientSchema]))
  .max(60)
  .transform((entries) => entries.map(coerceIngredient));
export const stepObjectSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  duration_seconds: z.number().int().min(0).max(86400).nullable().optional(),
  durationSeconds: z.number().int().min(0).max(86400).nullable().optional(),
  attention: z.enum(['active', 'passive']).optional(),
});

/**
 * Steps arrive as plain strings (every recipe written before this existed, and
 * every model that ignores the richer shape) or as objects carrying a duration
 * and whether the step needs hands.
 *
 * Both normalise to `RecipeStep`. Reading a legacy string array as structure
 * rather than migrating the rows means an older recipe still cooks — it simply
 * has no unattended steps to track, which is exactly true of what was stored.
 */
export const stepsSchema = z
  .array(z.union([z.string().trim().min(1).max(1000), stepObjectSchema]))
  .max(60)
  .transform((entries) =>
    entries.map((entry) => {
      if (typeof entry === 'string') {
        return { text: entry, durationSeconds: null, attention: 'active' as const };
      }
      const duration = entry.durationSeconds ?? entry.duration_seconds ?? null;
      return {
        text: entry.text,
        durationSeconds: duration && duration > 0 ? duration : null,
        // A step with unattended time is passive whether or not the model
        // remembered to say so: "simmer for forty minutes" does not need the
        // label to be true.
        attention: entry.attention ?? (duration && duration > 0 ? 'passive' : 'active'),
      };
    }),
  );

export const substitutionSchema = z.object({
  from: z.string().trim().min(1).max(120),
  to: z.string().trim().min(1).max(200),
  note: z.string().trim().max(300).default(''),
});

export const sessionNotesSchema = z
  .object({
    servings: z.number().int().min(1).max(50).optional(),
    substitutions: z.array(substitutionSchema).max(30).optional(),
    corrections: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    scratch: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  })
  .default({});

export const recipeInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  ingredients: ingredientsSchema.default([]),
  steps: stepsSchema.default([]),
  servings: z.number().int().min(1).max(50).default(2),
  source: z.string().trim().max(120).nullable().optional(),
});

export type RecipeInput = z.infer<typeof recipeInputSchema>;

export const memoryInputSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(2000),
  kind: z.enum(['preference', 'avoidance', 'note', 'observation']).default('preference'),
});

export const uuidSchema = z.string().uuid();

/** Parse or throw a 400 the route layer already knows how to render. */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what = 'request',
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}.`, result.error.flatten());
  }
  return result.data;
}

/**
 * JSONB that fails validation is a data problem, not a request problem: fall
 * back to a safe empty value rather than 500-ing a cooking session because one
 * legacy row has an odd shape.
 */
export function parseOrDefault<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  fallback: z.infer<T>,
): z.infer<T> {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}
