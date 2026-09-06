/**
 * WAV encoding for the speech-to-text upload.
 *
 * Whisper-compatible endpoints accept several container formats, and this
 * deliberately picks the dumbest one: a 44-byte header followed by signed
 * 16-bit samples. There is no codec state, no initialisation segment, and no
 * way for a slice of the signal to be undecodable — which is precisely the
 * failure mode that a container stream introduces when a rolling buffer drops
 * the chunk holding the header.
 *
 * Pure, and separated from anything browser-shaped, so the header layout is
 * unit-testable rather than something you find out about from a provider's
 * 400 response.
 */

const HEADER_BYTES = 44;

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);

  const bytesPerSample = 2;
  const channels = 1;
  const dataBytes = samples.length * bytesPerSample;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM format chunk length
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling: a sample above 1.0 would otherwise wrap around to
    // full-scale negative and arrive as a click.
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Joins windows into one signal. */
export function concatSamples(windows: Float32Array[], total?: number): Float32Array {
  const length = total ?? windows.reduce((sum, window) => sum + window.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const window of windows) {
    if (offset + window.length > length) {
      out.set(window.subarray(0, length - offset), offset);
      break;
    }
    out.set(window, offset);
    offset += window.length;
  }
  return out;
}
