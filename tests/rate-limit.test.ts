import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '@/lib/llm/provider';
import { ProviderError } from '@/lib/errors';

/**
 * What happens when the free tier says no.
 *
 * This is not an edge case on a free tier — it is a Tuesday. The cook has both
 * hands in a bowl, so the only acceptable outcomes are an answer, or a spoken
 * sentence they can act on. "The language model is rate limited" is neither.
 */

const config = {
  apiKey: 'test-key',
  model: 'big-model',
  fallbackModel: 'small-model',
  baseUrl: 'https://example.invalid/v1',
};

const signal = () => new AbortController().signal;

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

/** Queues HTTP replies and records which model each request asked for. */
function stubFetch(replies: Reply[]) {
  const models: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    models.push(JSON.parse(String(init.body)).model);
    const reply = replies.shift() ?? { status: 500 };
    return new Response(
      JSON.stringify(
        reply.body ?? {
          choices: [{ message: { content: 'Eight minutes.', tool_calls: [] } }],
        },
      ),
      { status: reply.status, headers: reply.headers },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { models };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('being rate limited mid-recipe', () => {
  it('waits out a limit the provider says is nearly over, rather than giving up', async () => {
    const { models } = stubFetch([
      { status: 429, headers: { 'retry-after': '0.05' } },
      { status: 200 },
    ]);

    const result = await new OpenAiCompatibleProvider(config).complete([], [], signal());

    expect(result.content).toBe('Eight minutes.');
    // Same model, tried again — not a downgrade the cook did not need.
    expect(models).toEqual(['big-model', 'big-model']);
  });

  it('answers on the other model when the wait would be too long to stand in silence', async () => {
    const { models } = stubFetch([
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 200 },
    ]);

    const result = await new OpenAiCompatibleProvider(config).complete([], [], signal());

    expect(result.content).toBe('Eight minutes.');
    // Straight to the fallback: no point sleeping a minute first.
    expect(models).toEqual(['big-model', 'small-model']);
  });

  it('falls back even when the provider does not say how long to wait', async () => {
    const { models } = stubFetch([{ status: 429 }, { status: 200 }]);

    await new OpenAiCompatibleProvider(config).complete([], [], signal());

    expect(models).toEqual(['big-model', 'small-model']);
  });

  it('says something a cook can act on when both models are exhausted', async () => {
    stubFetch([{ status: 429 }, { status: 429 }]);

    const error = await new OpenAiCompatibleProvider(config)
      .complete([], [], signal())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    const message = (error as ProviderError).message;
    // Spoken aloud, so: no status codes, no vendor names, and a next step.
    expect(message).not.toMatch(/429|rate limit/i);
    expect(message).toMatch(/minute/i);
  });

  it('reports a real failure on the fallback rather than hiding it behind the limit', async () => {
    stubFetch([
      { status: 429 },
      { status: 401, body: { error: { message: 'invalid api key' } } },
    ]);

    const error = await new OpenAiCompatibleProvider(config)
      .complete([], [], signal())
      .catch((e: unknown) => e);

    // A bad key is not something waiting a minute fixes, and telling the cook
    // to wait would send them back to the same wall five times.
    expect((error as ProviderError).message).toContain('401');
  });

  it('does not try the fallback when it is the same model', async () => {
    const { models } = stubFetch([{ status: 429 }, { status: 200 }]);

    await new OpenAiCompatibleProvider({ ...config, fallbackModel: 'big-model' })
      .complete([], [], signal())
      .catch(() => undefined);

    expect(models).toEqual(['big-model']);
  });
});
