import { describe, expect, it } from 'vitest';
import { regionFromLocale, regionFromTimeZone, resolveRegion } from '@/lib/region';
import { echoesPrompt, isLikelyHallucination } from '@/lib/stt/hallucinations';
import { buildMessages } from '@/lib/llm/prompt';
import { buildSnapshot } from '@/lib/cooking/state';
import type { CookingSession } from '@/lib/types';
import { ALICE } from './helpers/fixtures';

describe('working out where the cook is', () => {
  it('reads the region from a locale', () => {
    expect(regionFromLocale('en-IN')).toBe('IN');
    expect(regionFromLocale('en_GB')).toBe('GB');
    expect(regionFromLocale('hi-IN')).toBe('IN');
    expect(regionFromLocale('en')).toBeNull();
    expect(regionFromLocale(undefined)).toBeNull();
  });

  it('reads it from a timezone', () => {
    expect(regionFromTimeZone('Asia/Kolkata')).toBe('IN');
    expect(regionFromTimeZone('Asia/Calcutta')).toBe('IN');
    // A zone nobody mapped is better left unanswered than guessed.
    expect(regionFromTimeZone('Etc/UTC')).toBeNull();
  });

  it('prefers the timezone, because language is not location', () => {
    // Someone in Mumbai whose phone is set to British English. The locale says
    // Britain; they are standing in India, and it is the shops near them that
    // decide what a suggestion is worth.
    expect(resolveRegion('en-GB', 'Asia/Kolkata')).toBe('IN');
  });

  it('falls back to the locale when the zone is unknown', () => {
    expect(resolveRegion('en-IN', 'Etc/UTC')).toBe('IN');
    expect(resolveRegion(undefined, undefined)).toBeNull();
  });
});

describe('telling the model where the cook is', () => {
  const session: CookingSession = {
    id: 's1',
    userId: ALICE,
    recipeId: null,
    currentStep: 0,
    status: 'active',
    notes: {},
    createdAt: '',
    updatedAt: '',
  };

  const promptWith = (preferences: Record<string, unknown>) =>
    JSON.stringify(
      buildMessages({
        state: buildSnapshot(session, null, []),
        memory: [],
        preferences,
        history: [],
        utterance: 'what coffee should I buy?',
      }),
    );

  it('names the country rather than passing a code through', () => {
    const prompt = promptWith({ region: 'IN' });
    expect(prompt).toContain('Cooking in India');
    expect(prompt).not.toContain('Cooking in IN');
  });

  it('tells it to stick to what is available there', () => {
    expect(promptWith({ region: 'IN' })).toMatch(/only what is sold there/i);
  });

  it('says nothing about location when it does not know', () => {
    expect(promptWith({})).not.toMatch(/Cooking in/);
  });

  it('always warns off unavailable brands, region known or not', () => {
    // The failure was a confident recommendation of roasters that do not sell
    // in the user's country, so the instruction cannot depend on knowing it.
    for (const preferences of [{}, { region: 'IN' }]) {
      expect(promptWith(preferences)).toMatch(/Do not name a brand/i);
    }
  });

  it('forbids reciting the recipe', () => {
    expect(promptWith({})).toMatch(/Never recite the recipe/i);
  });
});

describe('the transcriber reading our own hint back', () => {
  const HINT =
    'Cooking conversation. Ingredients, quantities, grams, millilitres, teaspoons, tablespoons, timers, oven temperatures.';

  it('catches the exact phrase that reached the transcript', () => {
    // Observed live, and far more convincing than "Thank you." because it is
    // perfectly on topic.
    expect(echoesPrompt('Ingredients, quantities, and quantities.', HINT)).toBe(true);
    expect(isLikelyHallucination('Ingredients, quantities, and quantities.', HINT)).toBe(true);
  });

  it('catches other fragments of the same hint', () => {
    for (const text of [
      'Grams, millilitres, teaspoons.',
      'Cooking conversation.',
      'Timers, oven temperatures',
    ]) {
      expect(echoesPrompt(text, HINT), text).toBe(true);
    }
  });

  it('keeps a real question that happens to share vocabulary', () => {
    for (const text of [
      'how many grams of pasta do I need for four people',
      'what are the ingredients again',
      'set a timer for eight minutes',
      'how many teaspoons of salt should I put in the water',
    ]) {
      expect(isLikelyHallucination(text, HINT), text).toBe(false);
    }
  });

  it('does not judge long transcripts this way', () => {
    const long =
      'ingredients quantities grams millilitres teaspoons tablespoons timers oven temperatures and also something else entirely';
    expect(echoesPrompt(long, HINT)).toBe(false);
  });
});
