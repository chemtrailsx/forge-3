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
 * referenced as a static property path, so these cannot be looped over — which
 * is also why the publishable-key fallback below is written out in full rather
 * than resolved from a list of candidate names.
 *
 * Supabase is migrating from `anon` keys to `publishable` keys; both are the
 * browser-safe credential and both work with the same client, so either
 * variable name is accepted.
 */
export function publicEnv(): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
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
  model: nonEmpty.default('openai/gpt-oss-120b'),
  /**
   * Used only while the primary model is rate limited.
   *
   * The free tier meters each model separately, so when the large one is
   * exhausted this one is usually wide open — the difference between a
   * slightly plainer answer and a cook standing over a pan being told to come
   * back later. Same family, same key, same wire format, and it calls tools,
   * which a fallback has to: half this product is the timers.
   *
   * Verified present on the account rather than assumed — the obvious
   * candidates from other providers' catalogues are not all served here, and a
   * fallback that 404s is worse than none.
   */
  fallbackModel: nonEmpty.default('openai/gpt-oss-20b'),
  baseUrl: nonEmpty.url().default('https://api.groq.com/openai/v1'),
});

export type LlmEnv = z.infer<typeof llmSchema>;

/**
 * The model to fall back to when the configured one is rate limited.
 *
 * Same vendor, same key, smaller sibling: the free tier meters each model
 * separately, so this is usually open when the primary is not. It has to be a
 * model the account actually serves — `npm run preflight` checks that, because
 * a fallback that 404s is worse than no fallback at all.
 */
function fallbackFor(baseUrl: string): string {
  if (baseUrl.includes('googleapis.com')) return 'gemini-2.5-flash-lite';
  return 'openai/gpt-oss-20b';
}

export function llmEnv(): LlmEnv {
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GROQ_API_KEY ||
    '';

  const baseUrl =
    process.env.LLM_BASE_URL ||
    (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || apiKey.startsWith('AIza')
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
      : 'https://api.groq.com/openai/v1');

  const isGemini = baseUrl.includes('googleapis.com') || apiKey.startsWith('AIza');
  const isGroq = baseUrl.includes('groq.com') || apiKey.startsWith('gsk_');

  /*
   * The larger model is the default again. It was dropped to the small one to
   * dodge rate limits; those are now survivable — a limit is waited out or
   * answered on `fallbackModel` — and the larger model gives noticeably better
   * cooking answers, which is what the cook actually notices.
   */
  const defaultModel = isGemini
    ? 'gemini-2.5-flash'
    : isGroq
      ? 'openai/gpt-oss-120b'
      : 'gpt-4o-mini';

  const model = process.env.LLM_MODEL || process.env.GEMINI_MODEL || process.env.GROQ_MODEL || defaultModel;


  return llmSchema.parse({
    apiKey,
    model,
    fallbackModel: process.env.LLM_FALLBACK_MODEL || fallbackFor(baseUrl),
    baseUrl,
  });
}

export function geminiEnv(): LlmEnv | null {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    (process.env.LLM_BASE_URL?.includes('googleapis.com') ? process.env.LLM_API_KEY : undefined) ||
    (process.env.LLM_API_KEY?.startsWith('AIza') ? process.env.LLM_API_KEY : undefined);

  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.GEMINI_MODEL || (process.env.LLM_MODEL?.startsWith('gemini') ? process.env.LLM_MODEL : 'gemini-2.5-flash'),
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite',
    baseUrl: process.env.GEMINI_BASE_URL || (process.env.LLM_BASE_URL?.includes('googleapis.com') ? process.env.LLM_BASE_URL : 'https://generativelanguage.googleapis.com/v1beta/openai/'),
  };
}

export function groqEnv(): LlmEnv | null {
  const apiKey =
    process.env.GROQ_API_KEY ||
    process.env.FALLBACK_LLM_API_KEY ||
    (process.env.LLM_BASE_URL?.includes('groq.com') ? process.env.LLM_API_KEY : undefined) ||
    (process.env.LLM_API_KEY?.startsWith('gsk_') ? process.env.LLM_API_KEY : undefined);

  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.GROQ_MODEL || (process.env.LLM_MODEL?.includes('gpt-oss') ? process.env.LLM_MODEL : 'openai/gpt-oss-120b'),
    fallbackModel: process.env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-20b',
    baseUrl: process.env.GROQ_BASE_URL || (process.env.LLM_BASE_URL?.includes('groq.com') ? process.env.LLM_BASE_URL : 'https://api.groq.com/openai/v1'),
  };
}

const sttSchema = z.object({
  apiKey: nonEmpty,
  model: nonEmpty.default('whisper-large-v3-turbo'),
  endpoint: nonEmpty.url().default('https://api.groq.com/openai/v1/audio/transcriptions'),
});

export type SttEnv = z.infer<typeof sttSchema>;

export function sttEnv(): SttEnv {
  const apiKey =
    process.env.STT_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.FALLBACK_LLM_API_KEY ||
    (process.env.LLM_API_KEY?.startsWith('gsk_') ? process.env.LLM_API_KEY : process.env.LLM_API_KEY);

  return sttSchema.parse({
    apiKey,
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
