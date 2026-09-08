import { describe, expect, it, vi } from 'vitest';
import { FallbackLlmProvider } from '@/lib/llm/provider';
import type { LlmProvider, LlmStreamChunk } from '@/lib/llm/types';

/** A provider double. `streamWithTools` defaults to echoing `complete`. */
function fake(model: string, parts: Partial<LlmProvider> = {}): LlmProvider {
  return {
    model,
    complete: vi.fn(),
    stream: vi.fn().mockImplementation(async function* () {}),
    streamWithTools: vi.fn().mockImplementation(async function* () {}),
    ...parts,
  } as LlmProvider;
}

describe('FallbackLlmProvider', () => {
  it('uses primary provider when primary succeeds', async () => {
    const primary: LlmProvider = {
      model: 'gemini-2.5-flash',
      complete: vi.fn().mockResolvedValue({ content: 'from gemini', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'gemini stream';
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn().mockResolvedValue({ content: 'from groq', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'groq stream';
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const provider = new FallbackLlmProvider(primary, fallback);
    const result = await provider.complete([{ role: 'user', content: 'hello' }], [], new AbortController().signal);

    expect(result.content).toBe('from gemini');
    expect(primary.complete).toHaveBeenCalled();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('falls back to backup provider when primary complete fails', async () => {
    const primary: LlmProvider = {
      model: 'gemini-2.5-flash',
      complete: vi.fn().mockRejectedValue(new Error('Rate limit exceeded (429)')),
      stream: vi.fn().mockImplementation(async function* () {
        throw new Error('Rate limit exceeded (429)');
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn().mockResolvedValue({ content: 'from groq fallback', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'groq fallback stream';
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const provider = new FallbackLlmProvider(primary, fallback);
    const result = await provider.complete([{ role: 'user', content: 'hello' }], [], new AbortController().signal);

    expect(result.content).toBe('from groq fallback');
    expect(primary.complete).toHaveBeenCalled();
    expect(fallback.complete).toHaveBeenCalled();
  });

  it('falls back to backup provider when primary stream fails', async () => {
    const primary: LlmProvider = {
      model: 'gemini-2.5-flash',
      complete: vi.fn(),
      stream: vi.fn().mockImplementation(async function* () {
        throw new Error('Gemini 503 unavailable');
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn(),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'chunk1 ';
        yield 'chunk2';
      }),
      streamWithTools: vi.fn().mockImplementation(async function* () {}),
    };

    const provider = new FallbackLlmProvider(primary, fallback);
    const chunks: string[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('chunk1 chunk2');
    expect(fallback.stream).toHaveBeenCalled();
  });
  it('does not start again on the fallback once the cook has heard words', async () => {
    const primary = fake('gemini-2.5-flash', {
      stream: vi.fn().mockImplementation(async function* () {
        yield 'Melt the butter';
        throw new Error('connection reset');
      }),
    });
    const fallback = fake('openai/gpt-oss-20b', {
      stream: vi.fn().mockImplementation(async function* () {
        yield 'Melt the butter in a wide pan.';
      }),
    });

    const provider = new FallbackLlmProvider(primary, fallback);
    const heard: string[] = [];
    const read = async () => {
      for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], new AbortController().signal)) {
        heard.push(chunk);
      }
    };

    // The turn ends short rather than repeating itself. Half a sentence spoken
    // twice is worse than half a sentence, and the cook will simply ask again.
    await expect(read()).rejects.toThrow('connection reset');
    expect(heard).toEqual(['Melt the butter']);
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it('fails over on the first pass only before anything has been emitted', async () => {
    const primary = fake('gemini-2.5-flash', {
      streamWithTools: vi.fn().mockImplementation(async function* () {
        throw new Error('503 unavailable');
      }),
    });
    const fallback = fake('openai/gpt-oss-20b', {
      streamWithTools: vi.fn().mockImplementation(async function* () {
        yield { type: 'content', delta: 'Eight minutes.' } as LlmStreamChunk;
      }),
    });

    const provider = new FallbackLlmProvider(primary, fallback);
    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of provider.streamWithTools([{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ type: 'content', delta: 'Eight minutes.' }]);
  });
});
