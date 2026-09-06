import { z } from 'zod';
import type { Db } from '../db/context';
import type { LoadedState } from '../cooking/state';

/**
 * A backend tool.
 *
 * Three properties are deliberate:
 *
 *  - `execute` receives a `ToolContext`, never a user id. Identity comes from
 *    the session; the model cannot pass one, correctly or otherwise.
 *  - `schema` is a Zod schema, not just a JSON-schema blob for the model. The
 *    model's arguments are untrusted input and are parsed like any other.
 *  - `filler` lives with the tool, because the right thing to say while a
 *    lookup runs depends on what is being looked up.
 */

export type ToolContext = {
  db: Db;
  /** Live cooking state at the start of the turn. */
  state: LoadedState;
  /** Re-reads state after a tool mutated it. */
  reload: () => Promise<LoadedState>;
};

export type ToolResult = {
  /** Compact JSON handed back to the model. */
  data: unknown;
  /** True when the cooking state changed and the UI must be re-sent. */
  stateChanged?: boolean;
};

export type ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TSchema;
  /** JSON Schema handed to the model. */
  parameters: Record<string, unknown>;
  /** Spoken immediately when this tool starts, so there is no dead air. */
  filler: string[];
  execute: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
};

export function defineTool<TSchema extends z.ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): ToolDefinition<z.ZodTypeAny> {
  return definition as unknown as ToolDefinition<z.ZodTypeAny>;
}

/**
 * Minimal JSON-Schema helpers, so tool parameters stay readable inline.
 *
 * `jsonSchema(props, required)` builds the object schema; the attached helpers
 * build the properties. A schema builder library would be a dependency for
 * twenty lines of literal.
 */
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const jsonSchema = Object.assign(objectSchema, {
  string(description: string): Record<string, unknown> {
    return { type: 'string', description };
  },
  number(description: string): Record<string, unknown> {
    return { type: 'number', description };
  },
  integer(description: string): Record<string, unknown> {
    return { type: 'integer', description };
  },
  array(items: Record<string, unknown>, description: string): Record<string, unknown> {
    return { type: 'array', items, description };
  },
});
