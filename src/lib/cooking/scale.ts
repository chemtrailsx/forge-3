import type { Ingredient } from '../types';

/**
 * Recipe scaling.
 *
 * Two things make this more than a multiplication:
 *
 *  1. Ingredients with no quantity ("salt, for the pasta water") must survive
 *     scaling untouched rather than becoming `NaN g`.
 *  2. The result is spoken aloud, so it is rounded to something a person can
 *     act on. "266.6666 g of spaghetti" is arithmetically right and useless in
 *     a kitchen; the rounding step below is part of the feature, not polish.
 */

export type ScaledIngredient = Ingredient & { originalQuantity: number | null };

const WHOLE_UNITS = new Set(['clove', 'cloves', 'egg', 'eggs', 'slice', 'slices', 'sprig', 'sprigs']);

export function scaleQuantity(quantity: number, factor: number, unit: string | null): number {
  const raw = quantity * factor;
  const normalizedUnit = unit?.trim().toLowerCase() ?? '';

  // Countable things round to whole items — half an egg is not an instruction.
  if (WHOLE_UNITS.has(normalizedUnit)) return Math.max(1, Math.round(raw));

  // Grams / millilitres: round to 5 above 50, to 1 below, so the number is
  // sayable and still accurate enough to cook by.
  if (normalizedUnit === 'g' || normalizedUnit === 'ml') {
    return raw >= 50 ? Math.round(raw / 5) * 5 : Math.round(raw);
  }

  // Spoons and cups keep quarter precision.
  if (raw < 10) return Math.round(raw * 4) / 4;
  return Math.round(raw * 10) / 10;
}

export function scaleIngredients(
  ingredients: Ingredient[],
  fromServings: number,
  toServings: number,
): ScaledIngredient[] {
  if (fromServings <= 0) throw new RangeError('fromServings must be positive');
  if (toServings <= 0) throw new RangeError('toServings must be positive');

  const factor = toServings / fromServings;
  return ingredients.map((ingredient) => ({
    ...ingredient,
    originalQuantity: ingredient.quantity,
    quantity:
      ingredient.quantity === null
        ? null
        : scaleQuantity(ingredient.quantity, factor, ingredient.unit),
  }));
}

/** "200 g spaghetti" / "3 cloves garlic, thinly sliced" / "salt". */
export function formatIngredient(ingredient: Ingredient): string {
  const amount =
    ingredient.quantity === null
      ? ''
      : `${formatNumber(ingredient.quantity)}${ingredient.unit ? ` ${ingredient.unit}` : ''} `;
  const note = ingredient.note ? `, ${ingredient.note}` : '';
  return `${amount}${ingredient.name}${note}`.trim();
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}
