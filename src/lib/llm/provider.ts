import { geminiEnv, groqEnv, llmEnv, type LlmEnv } from '../env';
import { ProviderError } from '../errors';
import type {
  ChatMessage,
  ChatResult,
  LlmProvider,
  LlmStreamChunk,
  ToolCall,
  ToolSchema,
} from './types';

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

/**
 * Longest pause worth waiting out rather than answering on the other model.
 *
 * Past this the cook is standing in silence wondering whether the thing is
 * broken, which is worse than a plainer sentence arriving now.
 */
const MAX_RATE_LIMIT_WAIT_MS = 2500;

/**
 * How long the provider asked us to wait, in milliseconds.
 *
 * `retry-after` is seconds by convention but arrives fractional from some
 * providers ("1.48"), so it is parsed as a float. Returns null when the header
 * is absent or unusable, which is the caller's signal to stop waiting and try
 * the other model.
 */
function retryAfterMs(response: Response): number | null {
  const header =
    response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-requests');
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

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

  private async send(
    model: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    return fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, ...body }),
      signal,
    });
  }

  /**
   * One request, with the free tier's rate limits treated as weather rather
   * than as failure.
   *
   * A cook has both hands in a bowl. "The language model is rate limited right
   * now" is a true sentence and a useless one, so a 429 is worked around in
   * the two ways that actually recover the turn:
   *
   *   a short wait — the provider says how long, and a limit measured in a
   *   second or two is over before an apology would finish being spoken;
   *
   *   the other model — the free tier meters each one separately, so when the
   *   large model is exhausted the small one is usually wide open. A plainer
   *   answer beats no answer, and the cook cannot tell which one is speaking.
   *
   * Only then does it give up, and it says something the cook can act on.
   */
  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response = await this.send(this.config.model, body, signal);

    if (response.status === 429) {
      const waitMs = retryAfterMs(response);
      if (waitMs !== null && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs, signal);
        response = await this.send(this.config.model, body, signal);
      }
    }

    if (response.status === 429 && this.config.fallbackModel !== this.config.model) {
      const fallback = await this.send(this.config.fallbackModel, body, signal);
      // Only if it actually helped: a 429 from both means the account is out,
      // and the original response carries the better explanation.
      if (fallback.ok) return fallback;
      if (fallback.status !== 429) response = fallback;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      if (response.status === 400 && MALFORMED_TOOL_CALL.test(detail)) {
        throw new MalformedToolCallError(detail.slice(0, 200));
      }

      // Spoken aloud, to someone who cannot read a stack trace and did not
      // choose the model. Say what happened and what fixes it.
      const message =
        response.status === 429
          ? "I've hit my limit with the language service for the moment. Give it a minute and ask me again."
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
   * The first pass, streamed, so the answer can start being spoken while the
   * rest of it is still being written.
   *
   * Tool calls arrive as indexed fragments that have to be reassembled, and
   * `tool_start` is emitted as soon as the first fragment appears — the caller
   * needs to know it must not speak whatever content came before it.
   */
  async *streamWithTools(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    const response = await this.post(
      {
        messages: messages.map(toWire),
        temperature: 0.4,
        max_tokens: TOOL_CALL_TOKENS,
        stream: true,
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
      },
      signal,
    );

    const body = response.body;
    if (!body) throw new ProviderError('llm', 'Language model returned an empty stream.');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Fragments are keyed by index, because a model may interleave two calls.
    const building = new Map<number, { id: string; name: string; args: string }>();
    let announcedToolStart = false;

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

          let parsed: {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            // A frame split across reads; the next one completes it.
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.tool_calls && delta.tool_calls.length > 0) {
            if (!announcedToolStart) {
              announcedToolStart = true;
              yield { type: 'tool_start' };
            }
            for (const fragment of delta.tool_calls) {
              const index = fragment.index ?? 0;
              const current = building.get(index) ?? { id: '', name: '', args: '' };
              building.set(index, {
                id: fragment.id ?? current.id,
                name: fragment.function?.name ?? current.name,
                args: current.args + (fragment.function?.arguments ?? ''),
              });
            }
          }

          if (delta.content) yield { type: 'content', delta: delta.content };
        }
      }
    } finally {
      reader.releaseLock();
      if (signal.aborted) await body.cancel().catch(() => undefined);
    }

    if (building.size > 0) {
      const calls: ToolCall[] = [...building.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.args,
        }))
        .filter((call) => call.name);
      if (calls.length > 0) yield { type: 'tool_calls', calls };
    }
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

/**
 * Two providers, so one vendor having a bad day is not the product having one.
 *
 * This is a different failure from a rate limit, which `OpenAiCompatibleProvider`
 * already handles by waiting or switching model on the same account. This is
 * the account itself being unusable — the key revoked, the vendor down, the
 * region unreachable — and the only way through is somebody else's model.
 *
 * The rule throughout is **never fail over once the cook has heard something**.
 * A second provider restarting an answer from the beginning would speak the
 * first clause twice, which is worse than the error it is trying to hide.
 */
export class FallbackLlmProvider implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {}

  get model(): string {
    return `${this.primary.model} (fallback: ${this.fallback.model})`;
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): Promise<ChatResult> {
    try {
      return await this.primary.complete(messages, tools, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn('[llm] Primary LLM provider failed, falling back to backup provider:', error);
      return await this.fallback.complete(messages, tools, signal);
    }
  }

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    let spoke = false;
    try {
      for await (const delta of this.primary.stream(messages, signal)) {
        spoke = true;
        yield delta;
      }
      if (spoke || signal.aborted) return;
    } catch (error) {
      if (signal.aborted) return;
      // Mid-answer: the cook has already heard words. Starting again on
      // another provider would repeat them, so let the turn end short.
      if (spoke) throw error;
      console.warn('[llm] primary stream failed before saying anything; using the fallback', error);
    }

    for await (const delta of this.fallback.stream(messages, signal)) {
      yield delta;
    }
  }

  /**
   * The first pass, where the model either answers or picks tools.
   *
   * Failing over here is only safe before the first chunk: after that the
   * orchestrator may already have spoken a clause, or be part-way through
   * assembling a tool call.
   */
  async *streamWithTools(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamChunk> {
    let started = false;
    try {
      for await (const chunk of this.primary.streamWithTools(messages, tools, signal)) {
        started = true;
        yield chunk;
      }
      if (started || signal.aborted) return;
    } catch (error) {
      if (signal.aborted) return;
      if (started) throw error;
      console.warn('[llm] primary first pass failed before emitting; using the fallback', error);
    }

    for await (const chunk of this.fallback.streamWithTools(messages, tools, signal)) {
      yield chunk;
    }
  }
}

export function getLlmProvider(): LlmProvider {
  const gemini = geminiEnv();
  const groq = groqEnv();

  if (gemini && groq) {
    const primary = new OpenAiCompatibleProvider(gemini);
    const fallback = new OpenAiCompatibleProvider(groq);
    return new FallbackLlmProvider(primary, fallback);
  }

  if (gemini) {
    return new OpenAiCompatibleProvider(gemini);
  }

  if (groq) {
    return new OpenAiCompatibleProvider(groq);
  }

  return new OpenAiCompatibleProvider(llmEnv());
}
