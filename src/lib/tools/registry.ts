import { toolDelayMs } from '../env';
import { AppError } from '../errors';
import type { ToolSchema } from '../llm/types';
import {
  getRecentCookingSessionsTool,
  getRecipeTool,
  planRecipeTool,
  saveRecipeTool,
  scaleRecipeTool,
  searchUserRecipesTool,
  suggestSubstitutionTool,
} from './recipe-tools';
import { closeRecipeTool, saveUserPreferenceTool, setCurrentStepTool } from './session-tools';
import { getTimerStatusTool, startTimerTool } from './timer-tools';
import type { ToolContext, ToolDefinition } from './types';

/**
 * The tool surface the model can reach.
 *
 * Everything here runs server-side against the authenticated user's own rows.
 * The model chooses *which* tool to call; it never chooses whose data it runs
 * against.
 */
export const TOOLS: ToolDefinition[] = [
  planRecipeTool,
  getRecipeTool,
  searchUserRecipesTool,
  getRecentCookingSessionsTool,
  scaleRecipeTool,
  suggestSubstitutionTool,
  startTimerTool,
  getTimerStatusTool,
  saveRecipeTool,
  saveUserPreferenceTool,
  setCurrentStepTool,
  closeRecipeTool,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** Deterministic pick, so the same tool does not say the same thing twice. */
export function fillerFor(toolName: string, nonce: number): string | null {
  const tool = BY_NAME.get(toolName);
  if (!tool || tool.filler.length === 0) return null;
  return tool.filler[nonce % tool.filler.length] ?? null;
}

export type ToolOutcome = {
  name: string;
  ok: boolean;
  /** JSON string handed back to the model as the tool message. */
  content: string;
  stateChanged: boolean;
  durationMs: number;
};

/**
 * Execute one model-requested tool call.
 *
 * A failure is returned to the model as a tool result rather than thrown: "you
 * asked for a recipe that does not exist" is something it can recover from in
 * the same turn, and a thrown error would cost the user the whole reply.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const tool = BY_NAME.get(name);

  if (!tool) {
    return {
      name,
      ok: false,
      content: JSON.stringify({ error: `Unknown tool "${name}".` }),
      stateChanged: false,
      durationMs: 0,
    };
  }

  try {
    const parsedJson: unknown = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    const parsed = tool.schema.safeParse(stripNulls(parsedJson));
    if (!parsed.success) {
      return {
        name,
        ok: false,
        content: JSON.stringify({
          error: 'Invalid arguments.',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
        stateChanged: false,
        durationMs: Date.now() - startedAt,
      };
    }

    await maybeDelay(signal);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const result = await tool.execute(parsed.data, ctx);
    return {
      name,
      ok: true,
      content: JSON.stringify(result.data),
      stateChanged: result.stateChanged ?? false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const message =
      error instanceof AppError
        ? error.message
        : error instanceof SyntaxError
          ? 'Arguments were not valid JSON.'
          : 'The tool failed to run.';
    if (!(error instanceof AppError)) console.error(`[tool:${name}]`, error);
    return {
      name,
      ok: false,
      content: JSON.stringify({ error: message }),
      stateChanged: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Reads an explicit null as "not provided".
 *
 * The tool schemas permit null on every optional property, because models fill
 * in keys they were shown rather than omitting them. On this side of that
 * decision, `"unit": null` and a missing `unit` mean the same thing, and
 * treating them the same lets each Zod schema's own default decide what absent
 * becomes — `null` for a quantity that is genuinely "to taste", `''` for an
 * empty search.
 *
 * Arrays are walked too, since a dictated recipe's nulls are inside its
 * ingredient list rather than at the top level.
 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) continue;
    out[key] = stripNulls(entry);
  }
  return out;
}

/**
 * Artificial latency, off by default.
 *
 * The voice-filler behaviour only shows itself when a tool is slow enough to
 * leave a gap; on a fast connection every call returns before a filler could
 * finish. `TOOL_DELAY_MS` makes that path demonstrable without pretending the
 * work itself is slow.
 */
function maybeDelay(signal?: AbortSignal): Promise<void> {
  const ms = toolDelayMs();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
