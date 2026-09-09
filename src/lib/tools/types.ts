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
/**
 * Builds the object schema, and makes every optional property nullable.
 *
 * That last part is not a nicety. Providers validate tool arguments against
 * this schema before the call reaches us, and a model filling in every key it
 * was shown — writing `"note": null` rather than omitting `note` — is normal
 * behaviour, not a malfunction. Declaring an optional property as a bare
 * `string` therefore turns an ordinary completion into a provider-side 400
 * that costs the user the whole turn.
 *
 * So optionality is expressed once, in `required`, and the nullability that
 * implies is derived rather than remembered. `executeTool` completes the pair
 * by reading a null back as "not provided", so Zod's defaults still apply.
 */
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  const relaxed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (required.includes(key) || !value || typeof value !== 'object') {
      relaxed[key] = value;
      continue;
    }

    const property = { ...(value as Record<string, unknown>) };
    const type = property.type;

    if (typeof type === 'string' && type !== 'null') {
      property.type = [type, 'null'];
      // An enum has to admit null too, or the type and the enum disagree and
      // the validator rejects what the type just permitted.
      if (Array.isArray(property.enum) && !property.enum.includes(null)) {
        property.enum = [...property.enum, null];
      }
    }

    relaxed[key] = property;
  }

  return { type: 'object', properties: relaxed, required, additionalProperties: false };
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
  boolean(description: string): Record<string, unknown> {
    return { type: 'boolean', description };
  },
  array(items: Record<string, unknown>, description: string): Record<string, unknown> {
    return { type: 'array', items, description };
  },
  /**
   * A field the model may legitimately send as null.
   *
   * This has to be declared in the type, not just described in prose.
   * Providers validate tool arguments against this schema before the call ever
   * reaches us, so a description saying "null if not applicable" against a
   * bare `string` type is a contradiction the model obeys and the validator
   * then rejects — the whole turn fails, and the failure is the schema's
   * fault rather than the model's.
   */
  nullable(
    type: 'string' | 'number' | 'integer',
    description: string,
  ): Record<string, unknown> {
    return { type: [type, 'null'], description };
  },
});
