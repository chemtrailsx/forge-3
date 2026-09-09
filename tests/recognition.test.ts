import { describe, expect, it } from 'vitest';
import {
  RECOGNITION_FRAMING,
  buildRecognitionPrompt,
  distinctiveWords,
} from '@/lib/stt/vocabulary';
import { isLikelyHallucination } from '@/lib/stt/hallucinations';

/**
 * Reported from a real session: the cook said "lamb korma, paneer butter
 * masala and tandoori naan" and the transcript read "a naan korma with paneer
 * butter masala and with a durin naan". The assistant had named those dishes
 * one turn earlier, which is what makes this fixable — the right words were
 * already on the screen when the wrong ones were guessed.
 */

describe('priming the transcriber with the conversation', () => {
  it('carries the dishes the assistant just named', () => {
    const prompt = buildRecognitionPrompt({
      spoken:
        'How about a classic butter chicken with basmati rice, or a paneer tikka masala with naan? ' +
        'For a hearty option, a lamb korma with roti would also work.',
    });

    for (const word of ['korma', 'paneer', 'tikka', 'masala', 'basmati', 'roti']) {
      expect(prompt, word).toContain(word);
    }
  });

  it('carries the dish in progress and its ingredients', () => {
    const prompt = buildRecognitionPrompt({
      dishTitle: 'Tandoori chicken with jeera rice',
      ingredients: ['chicken thighs', 'hung curd', 'kasuri methi', 'garam masala'],
    });

    for (const word of ['tandoori', 'jeera', 'kasuri', 'methi', 'garam']) {
      expect(prompt, word).toContain(word);
    }
  });

  it('knows the words a general transcriber has no reason to expect', () => {
    // With nothing said yet, the first utterance of a session still has to
    // land — and it is usually the name of a dish.
    const prompt = buildRecognitionPrompt();
    for (const word of ['korma', 'tandoori', 'naan', 'paneer', 'biryani']) {
      expect(prompt, word).toContain(word);
    }
  });

  it('keeps the live words when there is more than fits', () => {
    const prompt = buildRecognitionPrompt({
      spoken: 'shakshuka labneh zaatar harissa preserved lemons',
      ingredients: Array.from({ length: 60 }, (_, i) => `filler${i}`),
    });

    expect(prompt.length).toBeLessThanOrEqual(700);
    // The dish named a second ago survives; the standing list is what gives.
    expect(prompt).toContain('shakshuka');
  });

  it('drops words that carry no recognition value', () => {
    const words = distinctiveWords('I want to make the one with the chicken');
    expect(words).toContain('chicken');
    expect(words).not.toContain('the');
    expect(words).not.toContain('want');
  });
});

describe('priming must not eat real speech', () => {
  /*
   * The trap in doing any of this. The artefact filter throws away a short
   * transcript made mostly of prompt words, because handed silence Whisper
   * reads its prompt back. Prime with dish names and the filter would discard
   * a cook naming a dish — the exact sentence this feature exists to hear.
   *
   * Which is why only the framing sentence is ever offered to the filter.
   */
  it('keeps a dish name that was primed for', () => {
    for (const said of [
      'lamb korma, paneer butter masala and tandoori naan',
      'paneer tikka masala',
      'korma',
      'tandoori naan',
    ]) {
      expect(isLikelyHallucination(said, RECOGNITION_FRAMING), said).toBe(false);
    }
  });

  it('still discards the framing sentence read back', () => {
    expect(isLikelyHallucination('A cook is talking about the dish.', RECOGNITION_FRAMING)).toBe(
      true,
    );
  });

  it('still discards what silence produces', () => {
    for (const artefact of ['Thank you.', 'Thanks for watching!', '[BLANK_AUDIO]', '...']) {
      expect(isLikelyHallucination(artefact, RECOGNITION_FRAMING), artefact).toBe(true);
    }
  });

  it('would have discarded a dish name had the vocabulary been the echo hint', () => {
    // Guards the reason for the split, not just its result: if someone passes
    // the full prompt here again, this fails.
    const fullPrompt = buildRecognitionPrompt({ spoken: 'lamb korma and tandoori naan' });
    expect(isLikelyHallucination('lamb korma and tandoori naan', fullPrompt)).toBe(true);
  });
});
