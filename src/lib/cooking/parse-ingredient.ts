import type { Ingredient } from '../types';
import { readSpokenNumber } from './spoken-numbers';

/**
 * Parses a spoken ingredient line into structure.
 *
 * The model is asked for `"1.6 kg whole chicken"`, not for
 * `{name, quantity, unit, note}`. Decomposing a dictated paragraph into nested
 * JSON is the part a small model gets wrong — it drops keys, sends nulls the
 * validator rejects, or gives up and sends strings anyway — whereas splitting a
 * quantity from a unit from a name is a job with one right answer that belongs
 * in code.
 *
 * Same reasoning as the substitution table: the model decides *what* to record,
 * deterministic code decides what it means. Getting a quantity wrong here is a
 * ruined dish, and it should not depend on sampling.
 */

const WORD_NUMBERS: Record<string, number> = { half: 0.5, quarter: 0.25 };

const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125,
};

/** Canonical unit for each spelling a person might say. */
const UNITS: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  clove: 'cloves', cloves: 'cloves',
  sprig: 'sprigs', sprigs: 'sprigs',
  slice: 'slices', slices: 'slices',
  stick: 'sticks', sticks: 'sticks',
  pinch: 'pinch', pinches: 'pinch',
  handful: 'handful', handfuls: 'handful',
  can: 'can', cans: 'can', tin: 'can', tins: 'can',
  bunch: 'bunch', bunches: 'bunch',
};

function toNumber(token: string): number | null {
  const cleaned = token.trim().toLowerCase();
  if (!cleaned) return null;

  if (cleaned in VULGAR_FRACTIONS) return VULGAR_FRACTIONS[cleaned] ?? null;
  if (cleaned in WORD_NUMBERS) return WORD_NUMBERS[cleaned] ?? null;

  // "1/2"
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(cleaned);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator === 0 ? null : numerator / denominator;
  }

  // "8-10 minutes" style ranges: take the lower bound, which is the amount a
  // cook can safely start with.
  const range = /^(\d+(?:\.\d+)?)\s*[-–—]\s*\d+(?:\.\d+)?$/.exec(cleaned);
  if (range) return Number(range[1]);

  const plain = /^\d+(?:\.\d+)?$/.exec(cleaned);
  return plain ? Number(cleaned) : null;
}

export function parseIngredient(line: string): Ingredient {
  const raw = line.trim().replace(/\s+/g, ' ');
  if (!raw) return { name: '', quantity: null, unit: null };

  // Anything after the first comma is preparation, not identity:
  // "garlic, thinly sliced".
  const commaAt = raw.indexOf(',');
  let head = commaAt === -1 ? raw : raw.slice(0, commaAt);
  const note = commaAt === -1 ? null : raw.slice(commaAt + 1).trim() || null;

  head = head.replace(/^(about|roughly|around|approximately)\s+/i, '');

  const tokens = head.split(' ');
  let quantity: number | null = null;
  let unit: string | null = null;
  let index = 0;

  const first = tokens[0];
  if (first !== undefined) {
    const digits = toNumber(first);
    if (digits !== null) {
      quantity = digits;
      index = 1;

      // "1 1/2 kg" — a mixed number spoken as two tokens.
      const second = tokens[1];
      if (second !== undefined && /^\d+\s*\/\s*\d+$|^[½¼¾⅓⅔⅛]$/.test(second)) {
        const extra = toNumber(second);
        if (extra !== null) {
          quantity += extra;
          index = 2;
        }
      }
    } else {
      // "thirty grams butter" — recognition returns what was said, so the
      // number often arrives as words. Without this the ingredient would have
      // no quantity and the scaler would silently skip it.
      const spoken = readSpokenNumber(tokens, 0);
      if (spoken) {
        quantity = spoken.value;
        index = spoken.next;
      }
    }
  }

  const unitToken = tokens[index];
  if (quantity !== null && unitToken !== undefined) {
    const canonical = UNITS[unitToken.toLowerCase().replace(/\.$/, '')];
    if (canonical) {
      unit = canonical;
      index += 1;
      // "3 cloves of garlic"
      if (tokens[index]?.toLowerCase() === 'of') index += 1;
    }
  }

  const name = tokens.slice(index).join(' ').trim();

  return {
    name: name || head.trim(),
    quantity,
    unit,
    ...(note ? { note } : {}),
  };
}

/** Accepts either shape, so a model that does send objects still works. */
export function coerceIngredient(value: string | Ingredient): Ingredient {
  return typeof value === 'string' ? parseIngredient(value) : value;
}
