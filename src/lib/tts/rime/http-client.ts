import type { RimeEnv } from '../../env';
import { ProviderError } from '../../errors';

/**
 * Rime's HTTP TTS endpoint.
 *
 * Used for the `quick` and `precise` profiles, because `timeScaleFactor` — the
 * documented speed control for `coda` — is honoured here and ignored over the
 * WebSocket. Those profiles are short, self-contained utterances, so a single
 * round trip costs less than it would on a streamed explanation.
 *
 * `Accept: audio/L16` returns raw signed 16-bit PCM, matching the WebSocket
 * path so the browser has exactly one decoder and one sample counter.
 */
export async function synthesizeHttp(
  config: RimeEnv,
  text: string,
  timeScaleFactor: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(config.httpEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: `audio/L16; rate=${config.samplingRate}`,
    },
    body: JSON.stringify({
      speaker: config.voiceId,
      modelId: config.modelId,
      text,
      lang: config.lang,
      samplingRate: config.samplingRate,
      // Documented range 0.4–2.5. Clamped rather than trusted so a bad profile
      // is a slightly-off delivery, not a 400 mid-sentence.
      timeScaleFactor: Math.min(2.5, Math.max(0.4, timeScaleFactor)),
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(
      'rime',
      `Rime HTTP synthesis failed (${response.status}). ${detail.slice(0, 200)}`,
      response.status === 401 || response.status === 403 ? 502 : 502,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

export type RimeVoice = { name?: string; id?: string; model?: string; modelId?: string };

/** Fetches Rime's live voice catalog, used by `npm run preflight`. */
export async function fetchCatalog(config: RimeEnv, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(config.catalogUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new ProviderError('rime', `Could not read Rime voice catalog (${response.status}).`);
  }
  return response.json();
}
