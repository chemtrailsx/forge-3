/** OpenAI-compatible chat types, narrowed to what this app actually sends. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model; validated before execution. */
  arguments: string;
};

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
};

/**
 * A streamed first pass.
 *
 * `tool_start` arrives the moment the model begins emitting a tool call, so
 * the caller can stop speaking content it had begun on. `tool_calls` carries
 * the assembled calls once the stream ends.
 */
export type LlmStreamChunk =
  | { type: 'content'; delta: string }
  | { type: 'tool_start' }
  | { type: 'tool_calls'; calls: ToolCall[] };

export interface LlmProvider {
  readonly model: string;
  complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): Promise<ChatResult>;
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /**
   * The first pass, streamed.
   *
   * Separate from `complete` because the answer can begin being spoken while
   * the rest of it is still being written — which on a spoken interface is the
   * difference between a reply and a pause.
   */
  streamWithTools(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamChunk>;
}
