import { describe, expect, it, vi } from 'vitest';
import { FallbackLlmProvider } from '@/lib/llm/provider';
import type { LlmProvider, ChatResult } from '@/lib/llm/types';

describe('FallbackLlmProvider', () => {
  it('uses primary provider when primary succeeds', async () => {
    const primary: LlmProvider = {
      model: 'gemini-2.5-flash',
      complete: vi.fn().mockResolvedValue({ content: 'from gemini', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'gemini stream';
      }),
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn().mockResolvedValue({ content: 'from groq', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'groq stream';
      }),
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
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn().mockResolvedValue({ content: 'from groq fallback', toolCalls: [] }),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'groq fallback stream';
      }),
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
    };

    const fallback: LlmProvider = {
      model: 'llama-3.3-70b-versatile',
      complete: vi.fn(),
      stream: vi.fn().mockImplementation(async function* () {
        yield 'chunk1 ';
        yield 'chunk2';
      }),
    };

    const provider = new FallbackLlmProvider(primary, fallback);
    const chunks: string[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('chunk1 chunk2');
    expect(fallback.stream).toHaveBeenCalled();
  });
});
