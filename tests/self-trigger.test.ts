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

    // A natural mid-sentence pause under the hangover threshold
    expect(feed(vad, 0.003, 500).filter(Boolean)).toEqual([]);
    expect(vad.isSpeaking).toBe(true);

    // Speech resumes and the utterance continues as one.
    expect(feed(vad, 0.25, 400).filter(Boolean)).toEqual([]);
  });

  it('still ends the turn once they have genuinely stopped', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.004, 800);
    feed(vad, 0.25, 600);
    expect(feed(vad, 0.003, DEFAULT_VAD.hangoverMs + 200)).toContain('speech-end');
  });
});
