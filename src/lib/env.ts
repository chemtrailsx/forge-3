import { z } from 'zod';

/**
 * Environment access, in one place.
 *
 * Two rules are enforced structurally rather than by convention:
 *
 *  1. `publicEnv()` is the only thing a client component may reach, and it can
 *     only ever contain NEXT_PUBLIC_ values.
 *  2. Every server secret is read lazily, inside a function. Reading them at
 *     module scope would evaluate during the client bundle's module graph
 *     analysis and make an accidental client import fail loudly at build time
 *     instead of silently shipping a key.
 */

const nonEmpty = z.string().trim().min(1);

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
});

export type PublicEnv = z.infer<typeof publicSchema>;

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only when it is
 * referenced as a static property path, so these cannot be looped over.
 */
export function publicEnv(): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

const rimeSchema = z.object({
  apiKey: nonEmpty,
  modelId: z.string().default('coda'),
  voiceId: z.string().default('astra'),
  lang: z.string().default('en'),
  audioFormat: z.enum(['pcm', 'wav', 'mp3', 'ogg', 'webm', 'mulaw']).default('pcm'),
  samplingRate: z.coerce.number().int().positive().default(24000),
  segment: z.enum(['immediate', 'never', 'bySentence']).default('immediate'),
  wsEndpoint: nonEmpty.default('wss://users-ws.rime.ai/ws3'),
  httpEndpoint: nonEmpty.url().default('https://users.rime.ai/v1/rime-tts'),
  catalogUrl: nonEmpty.url().default('https://users.rime.ai/data/voices/all-v2.json'),
});

export type RimeEnv = z.infer<typeof rimeSchema>;

export function rimeEnv(): RimeEnv {
  return rimeSchema.parse({
    apiKey: process.env.RIME_API_KEY,
    modelId: process.env.RIME_MODEL_ID || undefined,
    voiceId: process.env.RIME_VOICE_ID || undefined,
    lang: process.env.RIME_LANG || undefined,
    audioFormat: process.env.RIME_AUDIO_FORMAT || undefined,
    samplingRate: process.env.RIME_SAMPLING_RATE || undefined,
    segment: process.env.RIME_SEGMENT || undefined,
    wsEndpoint: process.env.RIME_ENDPOINT || undefined,
    httpEndpoint: process.env.RIME_HTTP_ENDPOINT || undefined,
    catalogUrl: process.env.RIME_CATALOG_URL || undefined,
  });
}

const llmSchema = z.object({
  apiKey: nonEmpty,
  model: nonEmpty.default('llama-3.3-70b-versatile'),
  baseUrl: nonEmpty.url().default('https://api.groq.com/openai/v1'),
});

export type LlmEnv = z.infer<typeof llmSchema>;

export function llmEnv(): LlmEnv {
  return llmSchema.parse({
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || undefined,
    baseUrl: process.env.LLM_BASE_URL || undefined,
  });
}

const sttSchema = z.object({
  apiKey: nonEmpty,
  model: nonEmpty.default('whisper-large-v3-turbo'),
  endpoint: nonEmpty.url().default('https://api.groq.com/openai/v1/audio/transcriptions'),
});

export type SttEnv = z.infer<typeof sttSchema>;

export function sttEnv(): SttEnv {
  return sttSchema.parse({
    apiKey: process.env.STT_API_KEY,
    model: process.env.STT_MODEL || undefined,
    endpoint: process.env.STT_ENDPOINT || undefined,
  });
}

export function serviceRoleKey(): string {
  return nonEmpty.parse(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Artificial tool latency. Exists so the voice-filler behaviour is
 * demonstrable on a fast network; 0 in production.
 */
export function toolDelayMs(): number {
  const parsed = z.coerce.number().int().min(0).max(15000).safeParse(process.env.TOOL_DELAY_MS ?? 0);
  return parsed.success ? parsed.data : 0;
}

export type ProviderDescriptors = {
  tts: {
    provider: 'rime';
    configured: boolean;
    modelId: string | null;
    voiceId: string | null;
    lang: string | null;
    audioFormat: string | null;
    /** Always a usable number so the browser can size its AudioContext. */
    samplingRate: number;
    segment: string | null;
    endpoint: string | null;
    transport: string;
  };
  llm: { configured: boolean; model: string | null; baseUrl: string | null };
  stt: { configured: boolean; model: string | null; endpoint: string | null };
};

/**
 * Secret-free description of the configured providers, safe to send to the UI.
 * Shapes are fixed rather than conditional, so a missing key is a `configured:
 * false` flag the interface can render, not an absent field it has to guard.
 */
export function providerDescriptors(): ProviderDescriptors {
  const rime = safe(() => rimeEnv());
  const llm = safe(() => llmEnv());
  const stt = safe(() => sttEnv());

  return {
    tts: {
      provider: 'rime',
      configured: rime !== null,
      modelId: rime?.modelId ?? null,
      voiceId: rime?.voiceId ?? null,
      lang: rime?.lang ?? null,
      audioFormat: rime?.audioFormat ?? null,
      samplingRate: rime?.samplingRate ?? 24000,
      segment: rime?.segment ?? null,
      endpoint: rime?.wsEndpoint ?? null,
      transport: 'websocket-json (ws3) + https, server-side proxied',
    },
    llm: { configured: llm !== null, model: llm?.model ?? null, baseUrl: llm?.baseUrl ?? null },
    stt: { configured: stt !== null, model: stt?.model ?? null, endpoint: stt?.endpoint ?? null },
  };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
