import { describe, expect, it } from 'vitest';
import { isReplayRequest } from '@/lib/voice/replay';

/**
 * This runs before the turn pipeline, so a false positive is expensive: the
 * cook asks a real question and gets the previous answer read back instead.
 * The tests are weighted accordingly — the "should not match" list is the
 * important one.
 */

describe('asking to hear it again', () => {
  it('recognises the plain forms', () => {
    for (const text of [
      'say that again',
      'Say that again.',
      'repeat that',
      'repeat',
      'again',
      'come again',
      'what did you say',
      'what was that',
      'one more time',
      'I missed that',
      "I didn't catch that",
      'pardon',
    ]) {
      expect(isReplayRequest(text), text).toBe(true);
    }
  });

  it('ignores politeness wrapped around it', () => {
    for (const text of [
      'sorry, say that again',
      'can you repeat that',
      'could you say that again',
      'please repeat that',
      'okay say that again please',
    ]) {
      expect(isReplayRequest(text), text).toBe(true);
    }
  });
});

describe('leaving real questions alone', () => {
  it('does not steal a question that merely contains a repeat word', () => {
    for (const text of [
      'how much butter again',
      'what was the temperature for the oven',
      'say the ingredients',
      'what do I do next',
      'how long again for the pasta',
      'can you repeat that but slower',
      'say that again more slowly',
      'repeat the last step but simpler',
      'what did you say about the garlic',
      'go back a step',
    ]) {
      expect(isReplayRequest(text), text).toBe(false);
    }
  });

  it('treats a request for a different delivery as a real turn', () => {
    // The model has not produced this yet, so it cannot come from the cache.
    expect(isReplayRequest('say that again slower')).toBe(false);
    expect(isReplayRequest('repeat that louder')).toBe(false);
  });

  it('ignores anything long enough to be a sentence', () => {
    expect(
      isReplayRequest('sorry I missed that could you tell me the amount of water one more time'),
    ).toBe(false);
  });

  it('ignores empty or meaningless input', () => {
    expect(isReplayRequest('')).toBe(false);
    expect(isReplayRequest('   ')).toBe(false);
    expect(isReplayRequest('...')).toBe(false);
  });
});
