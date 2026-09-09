import { describe, expect, it } from 'vitest';
import { isLikelyHallucination, normaliseTranscript } from '@/lib/stt/hallucinations';
import { DEFAULT_VAD, VoiceActivityDetector } from '@/lib/audio/vad';

/**
 * The feedback loop these guard against, observed in a real kitchen:
 *
 *   room noise trips the detector
 *     → a fragment of near-silence is transcribed
 *     → Whisper returns "Thank you." rather than nothing
 *     → the assistant answers a sentence nobody said
 *     → its reply reaches the microphone through the speakers
 *     → the detector trips again
 *
 * Every link is cut here: noise no longer reaches the transcriber, an artefact
 * that gets through is discarded, and the assistant's own voice needs to be
 * much louder to count as an interruption.
 */

describe('silence artefacts', () => {
  it('discards what a transcriber returns for silence', () => {
    for (const text of [
      'Thank you.',
      'thank you',
      'Thanks for watching!',
      'Thank you for watching.',
      'you',
      'Bye.',
      '[BLANK_AUDIO]',
      '(silence)',
      '♪♪♪',
      '...',
      '',
      '   ',
    ]) {
      expect(isLikelyHallucination(text), text).toBe(true);
    }
  });

  it('discards the artefact repeated, which is what longer silence produces', () => {
    expect(isLikelyHallucination('Thank you. Thank you. Thank you.')).toBe(true);
    expect(isLikelyHallucination('you you you')).toBe(true);
  });

  it('keeps anything a cook would actually say', () => {
    for (const text of [
      "what's next?",
      'I want to make pasta for three',
      'thank you, what do I do now',
      "wait, I haven't added the salt",
      'how much butter',
      'no',
      'yes',
      'next step',
    ]) {
      expect(isLikelyHallucination(text), text).toBe(false);
    }
  });

  it('normalises before comparing, so punctuation and case do not matter', () => {
    expect(normaliseTranscript('  Thank You!! ')).toBe('thank you');
  });
});

describe('not hearing itself', () => {
  const feed = (
    vad: VoiceActivityDetector,
    rms: number,
    ms: number,
    assistantSpeaking = false,
  ): Array<string | null> => {
    const events: Array<string | null> = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      events.push(vad.push(rms, 20, assistantSpeaking));
    }
    return events;
  };

  it('ignores leaked speaker audio that would otherwise read as a new turn', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1500);

    // Echo that survives cancellation: clearly above the quiet-room threshold,
    // and previously enough to start a turn.
    const leaked = DEFAULT_VAD.minRms * 1.6;
    expect(feed(vad, leaked, 1000, true).filter(Boolean)).toEqual([]);
  });

  it('still lets a real interruption through while it is speaking', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1500);
    // Someone leaning in and cutting across it.
    expect(feed(vad, 0.35, 400, true)).toContain('speech-start');
  });

  it('does not raise the noise floor to its own voice', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 2000);
    const floorBefore = vad.floor;

    feed(vad, 0.02, 3000, true);

    // If the floor chased the assistant's audio it would climb, and a genuine
    // interruption would then have to be louder and louder to be heard.
    expect(vad.floor).toBeCloseTo(floorBefore, 3);
  });
});

describe('rejecting a clip that is not speech', () => {
  const feed = (vad: VoiceActivityDetector, rms: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) vad.push(rms, 20);
  };

  it('rejects a short burst, which is a cupboard door and not a sentence', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1500);
    feed(vad, 0.2, 200);
    expect(vad.looksLikeSpeech()).toBe(false);
  });

  it('accepts a real utterance', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1500);
    feed(vad, 0.2, 900);
    expect(vad.looksLikeSpeech()).toBe(true);
  });

  it('forgets the previous utterance once reset', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1000);
    feed(vad, 0.2, 900);
    vad.reset();
    expect(vad.looksLikeSpeech()).toBe(false);
  });
});

describe('being cut off mid-sentence', () => {
  const feed = (vad: VoiceActivityDetector, rms: number, ms: number) => {
    const events: Array<string | null> = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 20) events.push(vad.push(rms, 20));
    return events;
  };

  it('survives the pause in "give me... two minutes"', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 800);
    feed(vad, 0.25, 600);

    // A natural mid-sentence pause. At the old 700 ms hangover this ended the
    // turn and the cook was cut off. It now reports a pause — which is what
    // starts transcription early — but crucially does not end the turn.
    const during = feed(vad, 0.003, 900).filter(Boolean);
    expect(during).toContain('speech-pause');
    expect(during).not.toContain('speech-end');
    expect(vad.isSpeaking).toBe(true);

    // Speech resumes and the utterance continues as one.
    expect(feed(vad, 0.25, 400).filter(Boolean)).toEqual([]);
  });

  /**
   * The eager endpoint is what removes most of the hangover from the wait, and
   * it is only safe because of this property: it fires once, and resuming
   * speech re-arms it. Anything transcribed from it is thrown away if the cook
   * carries on, and is the complete utterance if they do not.
   */
  it('announces a pause once, and again only after speech resumes', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 800);
    feed(vad, 0.25, 500);

    // One pause, however long the silence runs.
    const first = feed(vad, 0.003, 900).filter(Boolean);
    expect(first.filter((e) => e === 'speech-pause')).toHaveLength(1);

    // Resume, pause again: a second announcement, because the first snapshot
    // is now stale.
    feed(vad, 0.25, 400);
    const second = feed(vad, 0.003, 900).filter(Boolean);
    expect(second).toContain('speech-pause');
  });

  it('pauses well before it ends the turn, which is where the saving comes from', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 800);
    feed(vad, 0.25, 500);

    let elapsed = 0;
    let pausedAt: number | null = null;
    let endedAt: number | null = null;
    while (elapsed < 3000 && endedAt === null) {
      const event = vad.push(0.003, 20);
      elapsed += 20;
      if (event === 'speech-pause' && pausedAt === null) pausedAt = elapsed;
      if (event === 'speech-end') endedAt = elapsed;
    }

    expect(pausedAt).not.toBeNull();
    expect(endedAt).not.toBeNull();
    // Transcription gets this long a head start on the turn ending.
    expect(endedAt! - pausedAt!).toBeGreaterThan(500);
  });

  it('still ends the turn once they have genuinely stopped', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 800);
    feed(vad, 0.25, 600);
    expect(feed(vad, 0.003, DEFAULT_VAD.hangoverMs + 200)).toContain('speech-end');
  });
});

/**
 * Reported from a real kitchen: "it is stopping the listening and starting
 * processing in the middle of me speaking."
 *
 * The cause was a threshold keyed to the loudest window of the utterance. One
 * emphatic word set a bar that the quiet half of the same sentence could not
 * clear, so the detector called it silence and ended the turn while the cook
 * was still talking.
 */
describe('the quiet half of a sentence', () => {
  const feed = (vad: VoiceActivityDetector, rms: number, ms: number) => {
    const events: Array<string | null> = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 20) events.push(vad.push(rms, 20));
    return events.filter(Boolean);
  };

  it('keeps the turn open when the speaker drops after an emphatic word', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1000);

    // "I want to make WHITE SAUCE chicken pasta" — the stressed syllables are
    // several times the energy of the rest, and the rest runs on well past the
    // hangover. Under the old gate this whole stretch counted as silence, so
    // the turn was transcribed and answered while the cook was still speaking.
    feed(vad, 0.42, 400);
    const quieter = feed(vad, 0.09, DEFAULT_VAD.hangoverMs + 400);

    // 0.09 is under a quarter of that peak and still plainly speech.
    expect(quieter).not.toContain('speech-end');
    // Nor may it announce a pause: that is what starts transcribing early.
    expect(quieter).not.toContain('speech-pause');
    expect(vad.isSpeaking).toBe(true);
  });

  it('is not left deaf for the rest of the utterance by one loud noise', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1000);
    feed(vad, 0.2, 400);

    // A pan lid goes down mid-sentence.
    feed(vad, 0.9, 60);

    // The cook carries on at their normal level, which must still count —
    // for longer than the hangover, or the lid has ended their sentence.
    const after = feed(vad, 0.18, DEFAULT_VAD.hangoverMs + 400);
    expect(after).not.toContain('speech-end');
    expect(after).not.toContain('speech-pause');
    expect(vad.isSpeaking).toBe(true);
  });

  it('still ends the turn when they actually stop', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 1000);
    feed(vad, 0.3, 500);
    expect(feed(vad, 0.002, DEFAULT_VAD.hangoverMs + 200)).toContain('speech-end');
  });

  it('takes more to start than to continue, which is the whole point', () => {
    const quiet = new VoiceActivityDetector();
    feed(quiet, 0.004, 1000);
    // Below the onset bar: this must not open a turn on its own.
    expect(feed(quiet, 0.013, 600)).toEqual([]);
    expect(quiet.isSpeaking).toBe(false);
  });
});
