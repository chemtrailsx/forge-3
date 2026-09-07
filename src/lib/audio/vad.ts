/**
 * Voice activity detection policy.
 *
 * Pure state machine, fed RMS windows by the mic-meter worklet. Kept out of the
 * worklet so the thresholds can be tested directly — the difference between a
 * barge-in that works and one that fires on a boiling pan is entirely in these
 * numbers, and "we listened to it and it seemed fine" is not a test.
 *
 * The noise floor adapts, because a kitchen is not a quiet room: an extractor
 * fan, a boiling pan and a radio all raise the floor, and a fixed threshold
 * would either never trigger or trigger constantly.
 */

export type VadConfig = {
  /** How far above the noise floor counts as speech. */
  onsetMultiplier: number;
  /**
   * The same, while the assistant is talking.
   *
   * The microphone hears the speakers. Echo cancellation removes most of it
   * and not all of it, and what survives is loud enough to look like speech —
   * so the assistant answers itself, and the reply trips the detector again.
   * Demanding a clearly louder signal to interrupt costs nothing real: someone
   * cutting in is close to the microphone and means it.
   */
  duckedMultiplier: number;
  /** Absolute floor, so silence in a very quiet room still needs real signal. */
  minRms: number;
  /** Continuous speech before a turn is considered started. */
  onsetMs: number;
  /** Silence before the user's turn is considered finished. */
  hangoverMs: number;
  /** How fast the noise floor follows the ambient level (0–1 per window). */
  floorAdapt: number;
  /** Speech shorter than this was a noise, not a sentence. */
  minVoicedMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  onsetMultiplier: 3.5,
  duckedMultiplier: 12.0,
  minRms: 0.015,
  onsetMs: 80,
  hangoverMs: 650,
  floorAdapt: 0.05,
  minVoicedMs: 280,
};

export type VadEvent = 'speech-start' | 'speech-end' | null;

export class VoiceActivityDetector {
  private noiseFloor = 0.005;
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private speechMs = 0;
  private voicedMs = 0;
  private peak = 0;

  constructor(private readonly config: VadConfig = DEFAULT_VAD) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Milliseconds of continuous speech in the current turn. */
  get currentSpeechMs(): number {
    return this.speechMs;
  }

  /** Milliseconds that were actually above the threshold this utterance. */
  get currentVoicedMs(): number {
    return this.voicedMs;
  }

  /** Loudest window of the current utterance, for judging it against the floor. */
  get currentPeak(): number {
    return this.peak;
  }

  get floor(): number {
    return this.noiseFloor;
  }

  /**
   * Whether the utterance just captured looks like speech at all.
   *
   * Checked before anything is uploaded, because the cost of being wrong is
   * not a wasted request — it is the assistant confidently answering a
   * sentence nobody said.
   */
  looksLikeSpeech(): boolean {
    return this.voicedMs >= this.config.minVoicedMs && this.peak > this.noiseFloor * 2.5;
  }

  reset(): void {
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.speechMs = 0;
    this.voicedMs = 0;
    this.peak = 0;
  }

  /**
   * Feed one RMS window. Returns a transition, or null if nothing changed.
   *
   * @param assistantSpeaking raises the bar for what counts as speech, so the
   *        assistant does not hear itself through the speakers and reply to it.
   */
  push(rms: number, windowMs: number, assistantSpeaking = false): VadEvent {
    const multiplier = assistantSpeaking
      ? this.config.duckedMultiplier
      : this.config.onsetMultiplier;
    // When assistant is speaking through laptop speakers, echo bleed reaches 0.05-0.15 RMS.
    // Raise the floor requirement to 0.20 RMS and onset to 180ms so speaker audio never trips barge-in,
    // while real deliberate user interruption (> 0.25 RMS) still interrupts cleanly.
    const minThreshold = assistantSpeaking
      ? Math.max(this.config.minRms * 12.0, 0.20)
      : this.config.minRms;
    const baseThreshold = Math.max(minThreshold, this.noiseFloor * multiplier);
    // When actively speaking, audio must stay above background voice level to count as speech.
    // If it drops to slight ambient noise (< 30% of the speaker's peak), treat it as silence
    // so background noise does not prevent the turn from finishing.
    const speechThreshold = this.speaking
      ? Math.max(baseThreshold, this.peak * 0.28)
      : baseThreshold;
    const loud = rms > speechThreshold;

    // The floor only tracks quiet windows, and never while the assistant is
    // talking — adapting to its own voice would raise the floor until a real
    // interruption could not clear it.
    if (!loud && !assistantSpeaking) {
      this.noiseFloor += (rms - this.noiseFloor) * this.config.floorAdapt;
    }

    const requiredOnsetMs = assistantSpeaking
      ? Math.max(this.config.onsetMs, 180)
      : this.config.onsetMs;

    if (loud) {
      this.aboveMs += windowMs;
      this.belowMs = 0;
      this.peak = Math.max(this.peak, rms);
      if (this.speaking) {
        this.speechMs += windowMs;
        this.voicedMs += windowMs;
      }
      if (!this.speaking && this.aboveMs >= requiredOnsetMs) {
        this.speaking = true;
        this.speechMs = this.aboveMs;
        this.voicedMs = this.aboveMs;
        return 'speech-start';
      }
    } else {
      this.belowMs += windowMs;
      this.aboveMs = 0;
      if (this.speaking && this.belowMs >= this.config.hangoverMs) {
        this.speaking = false;
        this.speechMs = 0;
        return 'speech-end';
      }
    }

    return null;
  }
}
