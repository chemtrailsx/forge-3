/**
 * Round-trips the audio format: Rime speaks a sentence, the app's own WAV
 * encoder packages it exactly as the browser would, and Whisper transcribes it
 * back.
 *
 *   npm run verify:audio
 *
 * This exists because the microphone path failed in a way no unit test could
 * see. The recorder buffered container-format chunks and dropped the one
 * holding the header, so uploads were undecodable and the provider answered
 * `invalid_media_file`. Everything on both sides of that seam was fine; the
 * bytes in the middle were not.
 *
 * So this checks the bytes in the middle, against the real providers, without
 * needing a microphone: if Whisper can read what `encodeWav` produces, the
 * upload format is right. What it does *not* cover is capture itself — see the
 * README's limitations.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile('.env.local');
loadEnvFile('.env');

const SPOKEN = 'Add two hundred grams of spaghetti and cook it for eight minutes.';

async function main(): Promise<void> {
  const { rimeEnv, sttEnv } = await import('../src/lib/env');
  const { synthesizeHttp } = await import('../src/lib/tts/rime/http-client');
  const { encodeWav } = await import('../src/lib/audio/wav');

  const rime = rimeEnv();
  const stt = sttEnv();

  console.log(`Rime speaks: "${SPOKEN}"`);
  const pcm = await synthesizeHttp(rime, SPOKEN, 1.0, AbortSignal.timeout(30000));
  console.log(`  ${pcm.length} bytes of raw PCM at ${rime.samplingRate} Hz`);

  // Rime returns signed 16-bit little-endian PCM; the browser's recorder holds
  // Float32 windows. Converting here means the encoder under test is fed the
  // same shape of input it sees in the app.
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }

  const wav = encodeWav(samples, rime.samplingRate);
  const seconds = samples.length / rime.samplingRate;
  console.log(`  encoded ${wav.byteLength} bytes of WAV (${seconds.toFixed(2)} s)\n`);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', stt.model);
  form.append('response_format', 'json');

  const response = await fetch(stt.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stt.apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`FAIL  ${stt.model} rejected the upload (${response.status})`);
    console.error(`      ${detail.slice(0, 300)}`);
    process.exit(1);
  }

  const heard = ((await response.json()) as { text?: string }).text?.trim() ?? '';
  console.log(`Whisper heard: "${heard}"`);

  // Exact equality would be a test of the model, not of the format. What
  // matters is that the file decoded and the content survived recognisably.
  //
  // Each group is a set of acceptable spellings, because a transcriber may
  // legitimately write "200" or "two hundred" for the same sound. Requiring
  // spellings the model never promised would make this fail for the wrong
  // reason.
  const groups: Array<[string, string[]]> = [
    ['ingredient', ['spaghetti']],
    ['quantity', ['200', 'two hundred']],
    ['duration', ['8', 'eight']],
    ['unit', ['minute']],
  ];
  const lower = heard.toLowerCase();
  const matched = groups.filter(([, spellings]) => spellings.some((s) => lower.includes(s)));

  console.log('');
  if (heard.length === 0) {
    console.error('FAIL  the file decoded but transcribed to nothing');
    process.exit(1);
  }
  const ok = matched.length >= 3;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  round trip: ${matched.length}/${groups.length} groups matched (${matched.map(([name]) => name).join(', ') || 'none'})`,
  );
  process.exit(ok ? 0 : 1);
}

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
    // Absent file is fine.
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
