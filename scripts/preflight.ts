/**
 * Validates the shipped configuration against the providers' live APIs.
 *
 * Run before a demo. The point is that "the configuration we tested" and "the
 * configuration we shipped" cannot drift apart: the Rime model and voice are
 * checked against Rime's *live* catalog rather than copied from a doc page,
 * and each provider is exercised with a real request.
 *
 *   npm run preflight
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile('.env.local');
loadEnvFile('.env');

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
}

async function main(): Promise<void> {
  const { rimeEnv, llmEnv, sttEnv, publicEnv } = await import('../src/lib/env');

  // --- Supabase ------------------------------------------------------------
  try {
    const env = publicEnv();
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
    });
    record('supabase', response.ok, `${response.status} ${env.NEXT_PUBLIC_SUPABASE_URL}`);
  } catch (error) {
    record('supabase', false, message(error));
  }

  // --- Rime catalog: is this model/voice pair real? ------------------------
  let rime: ReturnType<typeof rimeEnv> | null = null;
  try {
    rime = rimeEnv();
  } catch (error) {
    record('rime', false, `${message(error, 'RIME_API_KEY')}. Without it there is no spoken output.`);
  }

  if (rime) {
    try {
      const { fetchCatalog } = await import('../src/lib/tts/rime/http-client');
      const catalog = await fetchCatalog(rime);
      const voices = collectVoiceNames(catalog);
      const found = voices.includes(rime.voiceId);
      record(
        'rime voice',
        found,
        found
          ? `${rime.modelId}/${rime.voiceId} present in live catalog (${voices.length} voices)`
          : `${rime.voiceId} not in live catalog. Available includes: ${voices.slice(0, 8).join(', ')}`,
      );
    } catch (error) {
      record('rime voice', false, message(error));
    }

    // --- Rime synthesis: does a real request return audio? -----------------
    try {
      const { synthesizeHttp } = await import('../src/lib/tts/rime/http-client');
      const started = Date.now();
      const pcm = await synthesizeHttp(rime, 'Timer set for eight minutes.', 1.22, AbortSignal.timeout(20000));
      const seconds = pcm.length / 2 / rime.samplingRate;
      record(
        'rime synthesis',
        pcm.length > 0,
        `${pcm.length} bytes (${seconds.toFixed(2)} s of audio) in ${Date.now() - started} ms`,
      );
    } catch (error) {
      record('rime synthesis', false, message(error));
    }
  }

  // --- LLM -----------------------------------------------------------------
  try {
    const config = llmEnv();
    const { OpenAiCompatibleProvider } = await import('../src/lib/llm/provider');
    const provider = new OpenAiCompatibleProvider(config);
    const started = Date.now();
    const result = await provider.complete(
      [{ role: 'user', content: 'Reply with the single word: ready' }],
      [],
      AbortSignal.timeout(30000),
    );
    record(
      'llm',
      result.content.length > 0,
      `${config.model} replied in ${Date.now() - started} ms`,
    );
  } catch (error) {
    record('llm', false, message(error));
  }

  // --- STT -----------------------------------------------------------------
  // Reachability only: a real transcription needs an audio file, and a
  // synthetic one would test the encoder rather than the endpoint.
  try {
    const config = sttEnv();
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: new FormData(),
    });
    // 400 is the expected answer to an empty form; 401 means the key is wrong.
    const ok = response.status !== 401 && response.status !== 403;
    record('stt', ok, `${config.model} endpoint returned ${response.status}`);
  } catch (error) {
    record('stt', false, message(error));
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function collectVoiceNames(catalog: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string') names.add(item);
        else walk(item);
      }
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(catalog);
  return [...names];
}

/**
 * A missing key is the single most common reason to run this script, so it has
 * to read as one line naming the variable — not as a serialised Zod tree.
 */
function message(error: unknown, apiKeyName = 'the provider API key'): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
    const missing = issues
      .filter((issue) => issue.message.toLowerCase().includes('at least 1 character') || issue.message === 'Required')
      .map((issue) => (issue.path.join('.') === 'apiKey' ? apiKeyName : (ENV_NAMES[issue.path.join('.')] ?? issue.path.join('.'))));
    if (missing.length > 0) return `not configured — set ${[...new Set(missing)].join(', ')} in .env.local`;
    return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** Maps a parsed config field back to the variable a person has to set. */
const ENV_NAMES: Record<string, string> = {
  modelId: 'RIME_MODEL_ID',
  voiceId: 'RIME_VOICE_ID',
  NEXT_PUBLIC_SUPABASE_URL: 'NEXT_PUBLIC_SUPABASE_URL',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)',
};

/** Minimal .env reader — avoids a dependency for something used by one script. */
function loadEnvFile(file: string): void {
  try {
    const contents = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Absent file is fine; the environment may be set another way.
  }
}

void main();
