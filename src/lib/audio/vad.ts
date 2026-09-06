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
  /** Absolute floor, so silence in a very quiet room still needs real signal. */
  minRms: number;
  /** Continuous speech before a turn is considered started. */
  onsetMs: number;
  /** Silence before the user's turn is considered finished. */
  hangoverMs: number;
  /** How fast the noise floor follows the ambient level (0–1 per window). */
  floorAdapt: number;
};

export const DEFAULT_VAD: VadConfig = {
  onsetMultiplier: 3.0,
  minRms: 0.012,
  // Short, because this is also the barge-in trigger: every millisecond here
  // is a millisecond the assistant keeps talking over the user.
  onsetMs: 120,
  // Long enough to survive the pause in "give me... two minutes", short enough
  // that the reply does not feel late.
  hangoverMs: 700,
  floorAdapt: 0.05,
};

export type VadEvent = 'speech-start' | 'speech-end' | null;

export class VoiceActivityDetector {
  private noiseFloor = 0.005;
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private speechMs = 0;

  constructor(private readonly config: VadConfig = DEFAULT_VAD) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Milliseconds of continuous speech in the current turn. */
  get currentSpeechMs(): number {
    return this.speechMs;
  }

  get floor(): number {
    return this.noiseFloor;
  }

  reset(): void {
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.speechMs = 0;
  }

  /** Feed one RMS window. Returns a transition, or null if nothing changed. */
  push(rms: number, windowMs: number): VadEvent {
    const threshold = Math.max(this.config.minRms, this.noiseFloor * this.config.onsetMultiplier);
    const loud = rms > threshold;

    // The floor only tracks quiet windows. Adapting during speech would chase
    // the speaker's own voice and desensitise the detector mid-sentence.
    if (!loud) {
      this.noiseFloor += (rms - this.noiseFloor) * this.config.floorAdapt;
    }

    if (loud) {
      this.aboveMs += windowMs;
      this.belowMs = 0;
      if (this.speaking) this.speechMs += windowMs;
      if (!this.speaking && this.aboveMs >= this.config.onsetMs) {
        this.speaking = true;
        this.speechMs = this.aboveMs;
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
