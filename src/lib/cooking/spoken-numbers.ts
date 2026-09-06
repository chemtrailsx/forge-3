/**
 * Reads numbers written as words.
 *
 * Speech recognition returns what was said, and a model relaying a dictated
 * recipe echoes it: "thirty grams butter", not "30 g butter". Treating that as
 * having no quantity is not a cosmetic loss — an ingredient with a null amount
 * is skipped by the scaler, so doubling the recipe silently leaves the butter
 * where it was.
 *
 * This is the inverse of `numberToWords` in lib/tts/speakable.ts: that one
 * turns 600 into "six hundred" for the speaker, this one turns "six hundred"
 * back into 600 for the arithmetic.
 */

const ONES: Record<string, number> = {
  zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const NAMED_FRACTIONS: Record<string, number> = {
  half: 0.5, quarter: 0.25, third: 1 / 3, thirds: 1 / 3, quarters: 0.25,
};

export type SpokenNumber = { value: number; next: number };

function normalise(token: string): string[] {
  // "twenty-five" is one token to a tokeniser and two words to a person.
  return token
    .toLowerCase()
    .replace(/[.,;:]$/, '')
    .split('-')
    .filter(Boolean);
}

function isNumberWord(word: string): boolean {
  return word in ONES || word in TENS || word === 'hundred' || word === 'thousand';
}

/**
 * Reads a spoken number starting at `tokens[start]`.
 *
 * Returns null when there is no number there at all, so the caller can tell
 * "no quantity given" from "a quantity of zero".
 */
export function readSpokenNumber(tokens: string[], start = 0): SpokenNumber | null {
  const words: string[] = [];
  let index = start;

  // Flatten hyphenated tokens while keeping track of how many real tokens we
  // consumed, so the caller can continue from the right place.
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    const parts = normalise(token);
    if (parts.length === 0 || !parts.every(isNumberWord)) break;
    words.push(...parts);
    index += 1;
  }

  if (words.length === 0) return null;

  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === 'hundred') {
      current = (current || 1) * 100;
    } else if (word === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
    } else if (word in TENS) {
      current += TENS[word] ?? 0;
    } else {
      current += ONES[word] ?? 0;
    }
  }
  let value = total + current;

  // "one point six"
  const pointToken = tokens[index];
  if (pointToken !== undefined && normalise(pointToken)[0] === 'point') {
    const digits: number[] = [];
    let after = index + 1;
    while (after < tokens.length) {
      const next = tokens[after];
      if (next === undefined) break;
      const word = normalise(next)[0] ?? '';
      const digit = /^\d$/.test(word) ? Number(word) : ONES[word];
      if (digit === undefined || digit > 9) break;
      digits.push(digit);
      after += 1;
    }
    if (digits.length > 0) {
      value = Number(`${value}.${digits.join('')}`);
      index = after;
    }
  }

  return { value, next: index };
}

/** "half a lemon", "a quarter teaspoon". */
export function readNamedFraction(token: string | undefined): number | null {
  if (token === undefined) return null;
  const word = normalise(token)[0] ?? '';
  return word in NAMED_FRACTIONS ? (NAMED_FRACTIONS[word] ?? null) : null;
}
