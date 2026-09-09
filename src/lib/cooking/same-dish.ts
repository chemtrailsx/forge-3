/**
 * Is this the dish already in the pan?
 *
 * Used to tell "we were making the white sauce pasta" — a cook resuming, who
 * must not lose their place — apart from "actually, let's do a biryani".
 *
 * Deliberately loose in one direction only. Treating two names for the same
 * dish as the same is harmless: the worst case is the assistant saying which
 * step they are on instead of writing a fresh recipe, and the cook can ask for
 * something else in the next breath. Treating the same dish as different is
 * what wipes their progress, so the comparison ignores the things people vary
 * without meaning anything by it: articles, filler words, plurals, word order,
 * and the accompaniments they may or may not mention.
 */

/** Words that carry no identity — "a pasta with garlic" is "garlic pasta". */
const IGNORED = new Set([
  'a', 'an', 'the', 'and', 'with', 'without', 'in', 'on', 'of', 'for', 'some', 'my', 'our',
  'style', 'homemade', 'quick', 'easy', 'simple', 'classic', 'traditional', 'basic', 'best',
  'recipe', 'dish', 'meal', 'plus', 'side', 'served', 'serve', 'plain', 'fresh',
]);

function significantWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Crude singularisation: "noodles" and "noodle" are the same dish.
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => !IGNORED.has(word));
  return new Set(words);
}

/**
 * True when two dish names plainly describe the same thing.
 *
 * Compared against the *shorter* name, because a cook resuming says less than
 * the recipe title holds: "white sauce pasta" against "White Sauce Chicken
 * Pasta with Garlic Bread" is the same dish being asked for by someone whose
 * hands are full.
 */
export function isSameDish(a: string, b: string): boolean {
  const left = significantWords(a);
  const right = significantWords(b);
  if (left.size === 0 || right.size === 0) return false;

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of smaller) if (larger.has(word)) shared += 1;

  // Every word of the shorter name, or all but one of a longer one. A single
  // shared word ("chicken") is not a dish, so two words must match at minimum.
  if (smaller.size === 1) return shared === 1 && larger.size === 1;
  return shared >= Math.max(2, smaller.size - 1);
}
