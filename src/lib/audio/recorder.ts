'use client';

import { concatSamples, encodeWav } from './wav';

/**
 * Utterance recorder.
 *
 * The microphone stream stays open for the whole session — that is what makes
 * barge-in possible — but only what the user actually said is uploaded, so the
 * recorder windows the signal by the VAD's decisions.
 *
 * It is fed 20 ms windows of raw samples by the mic worklet and keeps a short
 * ring buffer of them. That pre-roll matters: the VAD needs ~120 ms of signal
 * before it is confident, and those 120 ms are usually the first word. Keeping
 * raw samples rather than encoder output is what makes the ring buffer safe —
 * any run of Float32 windows is a complete signal, whereas dropping old chunks
 * of a container stream discards the header and produces a file no decoder
 * will accept.
 */

/** Pre-roll kept ahead of a detected onset. */
const PREROLL_MS = 400;

/**
 * Hard ceiling on one utterance. Someone who walks away mid-sentence should
 * cost us a bounded buffer, not the tab.
 */
const MAX_UTTERANCE_MS = 30_000;

/** Below this there is no word in there — a door slam, a pan lid. */
const MIN_UTTERANCE_MS = 250;

export class UtteranceRecorder {
  private readonly prerollWindows: Float32Array[] = [];
  private readonly utterance: Float32Array[] = [];
  private prerollSamples = 0;
  private utteranceSamples = 0;
  private capturing = false;

  constructor(readonly sampleRate: number) {}

  private get maxPrerollSamples(): number {
    return Math.round((PREROLL_MS / 1000) * this.sampleRate);
  }

  private get maxUtteranceSamples(): number {
    return Math.round((MAX_UTTERANCE_MS / 1000) * this.sampleRate);
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Feed one window from the mic worklet. */
  push(window: Float32Array): void {
    if (this.capturing) {
      if (this.utteranceSamples >= this.maxUtteranceSamples) return;
      this.utterance.push(window);
      this.utteranceSamples += window.length;
      return;
    }

    this.prerollWindows.push(window);
    this.prerollSamples += window.length;
    while (this.prerollSamples > this.maxPrerollSamples && this.prerollWindows.length > 1) {
      const dropped = this.prerollWindows.shift();
      this.prerollSamples -= dropped?.length ?? 0;
    }
  }

  /** Speech detected: keep everything from here, plus the pre-roll. */
  beginUtterance(): void {
    if (this.capturing) return;
    this.utterance.length = 0;
    this.utterance.push(...this.prerollWindows);
    this.utteranceSamples = this.prerollSamples;
    this.prerollWindows.length = 0;
    this.prerollSamples = 0;
    this.capturing = true;
  }

  /**
   * The utterance so far, without ending it.
   *
   * Used at a pause to start transcribing before the turn has formally ended.
   * If the cook resumes, that work is thrown away; if they do not, everything
   * after this point was silence and this snapshot is the whole utterance.
   */
  snapshot(): Blob | null {
    if (!this.capturing || this.utteranceSamples === 0) return null;
    if (this.utteranceSamples < (MIN_UTTERANCE_MS / 1000) * this.sampleRate) return null;

    const samples = concatSamples([...this.utterance], this.utteranceSamples);
    return new Blob([encodeWav(samples, this.sampleRate)], { type: 'audio/wav' });
  }

  /** Speech ended. Returns a WAV blob, or null if there was nothing usable. */
  endUtterance(): Blob | null {
    if (!this.capturing) return null;
    this.capturing = false;

    const windows = [...this.utterance];
    const total = this.utteranceSamples;
    this.utterance.length = 0;
    this.utteranceSamples = 0;

    if (total < (MIN_UTTERANCE_MS / 1000) * this.sampleRate) return null;

    const samples = concatSamples(windows, total);
    return new Blob([encodeWav(samples, this.sampleRate)], { type: 'audio/wav' });
  }

  /** Throw away an in-progress capture without producing a file. */
  cancelUtterance(): void {
    this.capturing = false;
    this.utterance.length = 0;
    this.utteranceSamples = 0;
  }

  reset(): void {
    this.cancelUtterance();
    this.prerollWindows.length = 0;
    this.prerollSamples = 0;
  }
}
