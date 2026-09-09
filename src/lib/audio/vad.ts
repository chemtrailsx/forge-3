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
  /**
   * How much of the onset threshold is enough to *stay* in speech.
   *
   * Below 1 by definition: a detector that needs as much energy to continue as
   * it needed to start truncates ordinary sentences at their quiet syllables.
   */
  releaseRatio: number;
  /**
   * Silence after which transcription may start, before the turn has ended.
   *
   * The hangover has to be long enough to survive the pause in "give me…​ two
   * minutes", and every millisecond of it is dead time the cook spends waiting.
   * Both are satisfiable at once: begin transcribing at this shorter mark, and
   * if speech resumes, throw that work away. If it does not resume, everything
   * after this point was silence — so the early transcript is the whole
   * utterance, and the rest of the hangover costs nothing.
   */
  eagerEndpointMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  onsetMultiplier: 3.5,
  // Tuned against real speaker bleed rather than guessed; see the absolute
  // floor in `push`, which is the other half of the same fix.
  duckedMultiplier: 12.0,
  minRms: 0.015,
  // Short, because this is also the barge-in trigger: every millisecond here
  // is a millisecond the assistant keeps talking over the user. While it is
  // speaking, `push` requires a longer onset instead.
  onsetMs: 80,
  /*
   * Long enough to survive the pauses in ordinary speech — "give me… two
   * minutes" — and the beat someone leaves while looking at a pan. At 700 ms
   * this cut people off mid-sentence, and every truncation costs a whole
   * round trip to recover from.
   *
   * Kept long deliberately, even though a short hangover is the obvious way to
   * cut the wait: `eagerEndpointMs` below buys the same time back without
   * truncating anyone, by transcribing during the hangover rather than
   * shortening it. The two settings are a pair — shortening this one to chase
   * latency undoes the reason it is long and gains nothing.
   */
  hangoverMs: 1100,
  floorAdapt: 0.05,
  /*
   * Enough headroom for the dynamic range of a sentence, not so much that the
   * detector never lets go. 0.6 keeps quiet syllables inside the turn while a
   * genuine stop still falls through within a window or two.
   */
  releaseRatio: 0.6,
  /*
   * A clip below this is a cupboard door or a lid. It matters more than it
   * sounds: transcribers do not return an empty string for a fragment of
   * noise, they return "Thank you." — and the assistant then answers it.
   */
  minVoicedMs: 320,
  /*
   * Long enough not to fire on the gap between words, short enough to hide
   * most of the remaining hangover behind the transcription round trip.
   */
  eagerEndpointMs: 420,
};

export type VadEvent = 'speech-start' | 'speech-pause' | 'speech-end' | null;

export class VoiceActivityDetector {
  private noiseFloor = 0.005;
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private speechMs = 0;
  private voicedMs = 0;
  private peak = 0;
  private pausedAnnounced = false;

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
    this.pausedAnnounced = false;
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
    /*
     * Hysteresis: it takes less to stay in speech than it took to enter it.
     *
     * Speech is not level. A stressed syllable can be several times the energy
     * of the unstressed one beside it, people trail off at the end of a phrase,
     * and there is near-silence between words. A detector that demands the
     * same energy throughout hears all of that as the end of the turn and cuts
     * the speaker off mid-sentence.
     *
     * This replaces a threshold keyed to the loudest window of the utterance,
     * which had the relationship backwards: because that peak never decayed, a
     * single emphatic word — or a pan lid — raised the bar for every quieter
     * word after it, and the quieter half of an ordinary sentence was read as
     * silence. Keying the release to the same adaptive floor as the onset
     * keeps the protection against steady background noise, without it.
     *
     * Not applied while the assistant is talking: there the threshold is an
     * echo guard, and lowering it would let the speakers interrupt it.
     */
    const threshold =
      this.speaking && !assistantSpeaking
        ? baseThreshold * this.config.releaseRatio
        : baseThreshold;
    const loud = rms > threshold;

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
      // Speech resumed, so whatever was started at the pause is stale.
      this.pausedAnnounced = false;
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
        this.pausedAnnounced = false;
        return 'speech-end';
      }
      if (this.speaking && !this.pausedAnnounced && this.belowMs >= this.config.eagerEndpointMs) {
        this.pausedAnnounced = true;
        return 'speech-pause';
      }
    }

    return null;
  }
}
