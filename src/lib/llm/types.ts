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

export interface LlmProvider {
  readonly model: string;
  complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): Promise<ChatResult>;
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}
