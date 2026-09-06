import { describe, expect, it } from 'vitest';
import { concatSamples, encodeWav } from '@/lib/audio/wav';

/**
 * These cover the seam that broke in real use.
 *
 * The first implementation buffered MediaRecorder output and kept a rolling
 * pre-roll of the last few chunks. That silently discarded the chunk holding
 * the container header, so every utterance after the first few hundred
 * milliseconds was undecodable and the provider answered
 * `invalid_media_file`. Nothing caught it because the encoding path had no
 * tests — the format was assumed rather than asserted.
 *
 * So the header layout is now checked byte by byte, and the ring buffer is
 * checked for the property that actually matters: no matter how much history
 * is discarded, what comes out is still a complete, decodable signal.
 */

const SAMPLE_RATE = 24000;

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('WAV encoding', () => {
  it('writes a header a decoder will accept', () => {
    const samples = new Float32Array(1000);
    const view = new DataView(encodeWav(samples, SAMPLE_RATE));

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(readAscii(view, 36, 4)).toBe('data');

    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('declares sizes that match the actual byte count', () => {
    const samples = new Float32Array(1000);
    const buffer = encodeWav(samples, SAMPLE_RATE);
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(44 + 1000 * 2);
    // RIFF size counts everything after the first eight bytes.
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(1000 * 2);
    // Byte rate and block align have to agree with the format, or players
    // reproduce the audio at the wrong speed rather than failing outright.
    expect(view.getUint32(28, true)).toBe(SAMPLE_RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
  });

  it('is decodable from any starting window, unlike a container stream', () => {
    // The property the old implementation lacked: a run of windows taken from
    // the middle of the signal still encodes to a complete file.
    const windows = Array.from({ length: 10 }, () => new Float32Array(480).fill(0.25));
    const tail = concatSamples(windows.slice(6));
    const view = new DataView(encodeWav(tail, SAMPLE_RATE));

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(40, true)).toBe(4 * 480 * 2);
  });

  it('clamps out-of-range samples instead of wrapping them into clicks', () => {
    const view = new DataView(encodeWav(new Float32Array([2, -2, 0]), SAMPLE_RATE));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('round-trips amplitude', () => {
    const view = new DataView(encodeWav(new Float32Array([0.5, -0.5]), SAMPLE_RATE));
    expect(view.getInt16(44, true)).toBeCloseTo(0.5 * 0x7fff, -1);
    expect(view.getInt16(46, true)).toBeCloseTo(-0.5 * 0x8000, -1);
  });

  it('encodes an empty signal without producing a malformed file', () => {
    const buffer = encodeWav(new Float32Array(0), SAMPLE_RATE);
    expect(buffer.byteLength).toBe(44);
    expect(new DataView(buffer).getUint32(40, true)).toBe(0);
  });
});

describe('window concatenation', () => {
  it('joins windows in order', () => {
    const joined = concatSamples([
      new Float32Array([1, 2]),
      new Float32Array([3, 4]),
      new Float32Array([5]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
  });

  it('truncates to a declared total rather than overrunning', () => {
    const joined = concatSamples([new Float32Array([1, 2]), new Float32Array([3, 4])], 3);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });

  it('handles no windows at all', () => {
    expect(concatSamples([]).length).toBe(0);
  });
});
