import type { Db } from '@/lib/db/context';
import type { LlmProvider, ChatMessage, ChatResult, ToolCall, ToolSchema } from '@/lib/llm/types';
import type { SpeakRequest, TtsEvent, TtsProvider, TtsDescriptor } from '@/lib/tts/types';
import { createFakeSupabase, type Tables } from './fake-supabase';

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

export const ALICE_RECIPE = 'aaaaaaaa-0000-4000-8000-000000000001';
export const BOB_RECIPE = 'bbbbbbbb-0000-4000-8000-000000000001';
export const ALICE_SESSION = 'aaaaaaaa-0000-4000-8000-000000000009';
export const BOB_SESSION = 'bbbbbbbb-0000-4000-8000-000000000009';

/** Two users with parallel data, so isolation failures show up as wrong rows. */
export function seedTables(): Tables {
  return {
    profiles: [
      { id: ALICE, display_name: 'alice', preferences: { defaultServings: 4 } },
      { id: BOB, display_name: 'bob', preferences: { defaultServings: 2 } },
    ],
    recipes: [
      {
        id: ALICE_RECIPE,
        user_id: ALICE,
        title: 'Weeknight Garlic Butter Pasta',
        servings: 2,
        is_favorite: true,
        source: 'starter',
        created_at: '2026-01-01T10:00:00.000Z',
        ingredients: [
          { name: 'spaghetti', quantity: 200, unit: 'g' },
          { name: 'salted butter', quantity: 40, unit: 'g' },
          { name: 'garlic', quantity: 3, unit: 'cloves', note: 'thinly sliced' },
          { name: 'salt', quantity: null, unit: null, note: 'for the water' },
        ],
        steps: [
          'Bring a large pan of water to a rolling boil and salt it well.',
          'Add the spaghetti and cook for eight minutes.',
          'Melt the butter in a wide pan over low heat.',
          'Toss the drained pasta through the garlic butter.',
        ],
      },
      {
        id: BOB_RECIPE,
        user_id: BOB,
        title: "Bob's Secret Chilli",
        servings: 6,
        is_favorite: false,
        source: 'private',
        created_at: '2026-01-02T10:00:00.000Z',
        ingredients: [{ name: 'kidney beans', quantity: 400, unit: 'g' }],
        steps: ['Do not tell anyone.'],
      },
    ],
    cooking_sessions: [
      {
        id: ALICE_SESSION,
        user_id: ALICE,
        recipe_id: ALICE_RECIPE,
        current_step: 1,
        status: 'active',
        notes: {},
        created_at: '2026-02-01T10:00:00.000Z',
        updated_at: '2026-02-01T10:00:00.000Z',
      },
      {
        id: BOB_SESSION,
        user_id: BOB,
        recipe_id: BOB_RECIPE,
        current_step: 0,
        status: 'active',
        notes: {},
        created_at: '2026-02-01T11:00:00.000Z',
        updated_at: '2026-02-01T11:00:00.000Z',
      },
    ],
    user_memory: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000101',
        user_id: ALICE,
        key: 'spice_level',
        value: 'does not like very spicy food',
        kind: 'preference',
        updated_at: '2026-01-05T10:00:00.000Z',
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000102',
        user_id: ALICE,
        key: 'allergy',
        value: 'allergic to walnuts',
        kind: 'avoidance',
        updated_at: '2026-01-06T10:00:00.000Z',
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000101',
        user_id: BOB,
        key: 'spice_level',
        value: 'loves extremely spicy food',
        kind: 'preference',
        updated_at: '2026-01-05T10:00:00.000Z',
      },
    ],
    timers: [],
    conversation_turns: [],
  };
}

export function makeDb(userId: string, tables: Tables = seedTables()) {
  const fake = createFakeSupabase({ tables, rlsUserId: userId });
  const db: Db = { supabase: fake.client, userId };
  return { db, fake };
}

// --- provider doubles ------------------------------------------------------

export type ScriptedTurn = { content: string; toolCalls?: ToolCall[] };

/**
 * A scripted LLM. `complete` returns the next scripted turn; `stream` emits the
 * following one word by word, which is what the orchestrator does after tools.
 */
export class FakeLlm implements LlmProvider {
  readonly model = 'fake-model';
  readonly completeCalls: ChatMessage[][] = [];
  readonly streamCalls: ChatMessage[][] = [];
  readonly toolSchemas: ToolSchema[][] = [];

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly streamText = '',
    private readonly delayMs = 0,
  ) {}

  private index = 0;

  async complete(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal,
  ): Promise<ChatResult> {
    this.completeCalls.push(messages);
    this.toolSchemas.push(tools);
    if (this.delayMs > 0) await abortableSleep(this.delayMs, signal);
    const turn = this.script[Math.min(this.index++, this.script.length - 1)];
    return { content: turn?.content ?? '', toolCalls: turn?.toolCalls ?? [] };
  }

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    this.streamCalls.push(messages);
    for (const word of this.streamText.split(' ')) {
      if (signal.aborted) return;
      yield `${word} `;
    }
  }
}

/**
 * A TTS double that emits deterministic PCM and word timings, so tests can
 * assert on cut points without a provider.
 */
export class FakeTts implements TtsProvider {
  readonly samplingRate = 24000;
  readonly spoken: SpeakRequest[] = [];
  cancelled = 0;
  closed = 0;

  constructor(
    /** Milliseconds between chunks, for exercising cancellation mid-stream. */
    private readonly chunkDelayMs = 0,
    private readonly chunksPerUtterance = 3,
  ) {}

  descriptor(): TtsDescriptor {
    return {
      provider: 'fake',
      modelId: 'fake',
      voiceId: 'fake',
      lang: 'en',
      audioFormat: 'pcm',
      samplingRate: this.samplingRate,
      transport: 'memory',
      endpoint: 'memory://',
    };
  }

  async *speak(request: SpeakRequest, signal: AbortSignal): AsyncIterable<TtsEvent> {
    this.spoken.push(request);
    const words = request.text.split(/\s+/).filter(Boolean);

    yield {
      type: 'timestamps',
      contextId: request.contextId,
      words,
      start: words.map((_, index) => index * 0.3),
      end: words.map((_, index) => (index + 1) * 0.3),
    };

    for (let seq = 0; seq < this.chunksPerUtterance; seq += 1) {
      if (signal.aborted) return;
      if (this.chunkDelayMs > 0) await abortableSleep(this.chunkDelayMs, signal);
      if (signal.aborted) return;
      yield {
        type: 'audio',
        contextId: request.contextId,
        seq,
        pcm: Buffer.alloc(480 * 2, seq + 1),
      };
    }

    yield { type: 'done', contextId: request.contextId };
  }

  cancel(): void {
    this.cancelled += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
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

export function toolCall(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
