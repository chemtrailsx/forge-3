import { llmEnv, type LlmEnv } from '../env';
import { ProviderError } from '../errors';
import type { ChatMessage, ChatResult, LlmProvider, ToolCall, ToolSchema } from './types';

/**
 * An OpenAI-compatible chat client.
 *
 * Written against the wire format rather than a vendor SDK so the provider is
 * an environment variable: the default is Groq's free tier, and pointing
 * `LLM_BASE_URL` at OpenAI, Together, Ollama or anything else compatible needs
 * no code change. That also keeps the dependency list short — this is one
 * `fetch` and two response shapes.
 */

type WireMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

function toWire(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name,
      };
    default:
      return { role: message.role, content: message.content };
  }
}

/** Providers word this differently; all of them mean the same thing. */
const MALFORMED_TOOL_CALL = /tool_use_failed|failed to parse tool call|invalid tool call/i;

/**
 * Room for one reply. Generous because `plan_recipe` writes a whole recipe in
 * a single tool call, and a recipe cut off mid-brace is unparseable rather
 * than merely short.
 */
const TOOL_CALL_TOKENS = 1400;

class MalformedToolCallError extends Error {
  constructor(detail: string) {
    super(`The model produced an unparseable tool call. ${detail}`);
    this.name = 'MalformedToolCallError';
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly config: LlmEnv) {}

  get model(): string {
    return this.config.model;
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.config.model, ...body }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      // A tool call the model failed to write as valid JSON. This is a
      // sampling failure, not a request that will never work: the same prompt
      // usually succeeds on a second attempt, and the alternative is losing
      // the user's entire turn to a truncated brace.
      if (response.status === 400 && MALFORMED_TOOL_CALL.test(detail)) {
        throw new MalformedToolCallError(detail.slice(0, 200));
      }

      // Rate limits are the common failure on a free tier, and the difference
      // matters to the caller: retry later vs. fix your key.
      const message =
        response.status === 429
          ? 'The language model is rate limited right now.'
          : `Language model request failed (${response.status}). ${detail.slice(0, 200)}`;
      throw new ProviderError('llm', message);
    }
    return response;
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const request = (maxTokens: number) => ({
      messages: messages.map(toWire),
      temperature: 0.4,
      max_tokens: maxTokens,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
    });

    // A whole recipe is a large tool call, and truncation is one of the ways
    // it comes back unparseable — so the retry is given more room rather than
    // simply rolling the dice again on the same budget.
    let response: Response;
    try {
      response = await this.post(request(TOOL_CALL_TOKENS), signal);
    } catch (error) {
      if (!(error instanceof MalformedToolCallError) || signal.aborted) throw error;
      console.warn('[llm] retrying after an unparseable tool call');
      try {
        response = await this.post(request(TOOL_CALL_TOKENS * 2), signal);
      } catch (retryError) {
        if (!(retryError instanceof MalformedToolCallError)) throw retryError;
        // Twice is enough. Surfacing it as a provider error means the turn
        // ends with something spoken rather than with silence.
        throw new ProviderError(
          'llm',
          'The assistant could not put that together. Ask again in a moment.',
        );
      }
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: WireMessage }>;
    };
    const message = payload.choices?.[0]?.message;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));

    return { content: message?.content ?? '', toolCalls };
  }

  /**
   * Streams the final answer token by token so the orchestrator can hand Rime
   * a finished clause while the model is still writing the next one. On a
   * spoken interface that difference is the gap between a reply and a pause.
   */
  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    const response = await this.post(
      { messages: messages.map(toWire), temperature: 0.4, max_tokens: 500, stream: true },
      signal,
    );

    const body = response.body;
    if (!body) throw new ProviderError('llm', 'Language model returned an empty stream.');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // A partial frame split across chunks; the next read completes it.
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (signal.aborted) await body.cancel().catch(() => undefined);
    }
  }
}

export function getLlmProvider(): LlmProvider {
  return new OpenAiCompatibleProvider(llmEnv());
}
