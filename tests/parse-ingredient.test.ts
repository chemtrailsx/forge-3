import { describe, expect, it } from 'vitest';
import { coerceIngredient, parseIngredient } from '@/lib/cooking/parse-ingredient';
import { formatIngredient } from '@/lib/cooking/scale';
import { scaleIngredients } from '@/lib/cooking/scale';

/**
 * `save_recipe` asks the model for spoken lines rather than nested objects,
 * because that is the part a small model reliably gets right. That moves the
 * burden here — and a quantity parsed wrong is a ruined dish, so this is the
 * function that has to be exhaustively tested rather than the prompt.
 */

describe('parsing a dictated ingredient', () => {
  it('splits quantity, unit and name', () => {
    expect(parseIngredient('200 g spaghetti')).toEqual({
      name: 'spaghetti',
      quantity: 200,
      unit: 'g',
    });
  });

  it('normalises spoken unit spellings', () => {
    expect(parseIngredient('1.6 kilos whole chicken').unit).toBe('kg');
    expect(parseIngredient('2 tablespoons olive oil').unit).toBe('tbsp');
    expect(parseIngredient('30 grams butter').unit).toBe('g');
    expect(parseIngredient('1 tin chopped tomatoes').unit).toBe('can');
  });

  it('handles a countable item with no unit', () => {
    expect(parseIngredient('2 lemons')).toEqual({ name: 'lemons', quantity: 2, unit: null });
  });

  it('keeps an amount-less ingredient intact', () => {
    expect(parseIngredient('salt and black pepper')).toEqual({
      name: 'salt and black pepper',
      quantity: null,
      unit: null,
    });
  });

  it('treats anything after a comma as preparation, not identity', () => {
    expect(parseIngredient('3 cloves garlic, thinly sliced')).toEqual({
      name: 'garlic',
      quantity: 3,
      unit: 'cloves',
      note: 'thinly sliced',
    });
  });

  it('drops a connecting "of"', () => {
    expect(parseIngredient('3 cloves of garlic')).toMatchObject({
      name: 'garlic',
      unit: 'cloves',
    });
  });

  it('reads spoken numbers', () => {
    expect(parseIngredient('two lemons').quantity).toBe(2);
    expect(parseIngredient('four sprigs thyme')).toMatchObject({ quantity: 4, unit: 'sprigs' });
    expect(parseIngredient('a pinch of saffron')).toMatchObject({ quantity: 1, unit: 'pinch' });
  });

  /**
   * These are transcripts from a real dictation. Speech recognition returns
   * words, and the model relays them, so "thirty grams butter" is the normal
   * case rather than the exotic one. Parsing it as having no quantity is what
   * makes a doubled recipe quietly keep the original amount of butter.
   */
  it('reads quantities spoken as words', () => {
    expect(parseIngredient('thirty grams butter')).toEqual({
      name: 'butter',
      quantity: 30,
      unit: 'g',
    });
    expect(parseIngredient('two hundred grams spaghetti')).toMatchObject({
      quantity: 200,
      unit: 'g',
      name: 'spaghetti',
    });
    expect(parseIngredient('seventy five grams parmesan')).toMatchObject({ quantity: 75 });
    expect(parseIngredient('twenty-five grams sugar')).toMatchObject({ quantity: 25 });
  });

  it('reads a spoken decimal', () => {
    expect(parseIngredient('one point six kilograms whole chicken')).toEqual({
      name: 'whole chicken',
      quantity: 1.6,
      unit: 'kg',
    });
  });

  it('scales a word-quantity ingredient like any other', () => {
    const scaled = scaleIngredients([parseIngredient('thirty grams butter')], 2, 6);
    expect(scaled[0]?.quantity).toBe(90);
  });

  it('reads fractions in either notation', () => {
    expect(parseIngredient('1/2 tsp chilli flakes')).toMatchObject({ quantity: 0.5, unit: 'tsp' });
    expect(parseIngredient('½ tsp chilli flakes')).toMatchObject({ quantity: 0.5, unit: 'tsp' });
    expect(parseIngredient('1 1/2 kg potatoes')).toMatchObject({ quantity: 1.5, unit: 'kg' });
  });

  it('ignores hedging words a person says out loud', () => {
    expect(parseIngredient('about 1.6 kg whole chicken')).toMatchObject({
      quantity: 1.6,
      unit: 'kg',
      name: 'whole chicken',
    });
  });

  it('takes the lower bound of a range, which is the safe amount to start with', () => {
    expect(parseIngredient('2-3 tbsp olive oil')).toMatchObject({ quantity: 2, unit: 'tbsp' });
  });

  it('never invents a unit from a word that only looks like one', () => {
    // "canned" is not "can"; the name must survive intact.
    expect(parseIngredient('400 g canned chickpeas')).toMatchObject({
      quantity: 400,
      unit: 'g',
      name: 'canned chickpeas',
    });
  });

  it('survives an empty or nonsense line', () => {
    expect(parseIngredient('')).toEqual({ name: '', quantity: null, unit: null });
    expect(parseIngredient('   ')).toEqual({ name: '', quantity: null, unit: null });
  });
});

describe('round trip', () => {
  it('formats back to something a person would recognise', () => {
    for (const line of [
      '200 g spaghetti',
      '3 cloves garlic, thinly sliced',
      '2 lemons',
      'salt and black pepper',
    ]) {
      expect(formatIngredient(parseIngredient(line))).toBe(line);
    }
  });

  it('produces structure the scaler can actually use', () => {
    const parsed = ['200 g spaghetti', '2 lemons', 'salt'].map(parseIngredient);
    const scaled = scaleIngredients(parsed, 2, 6);

    expect(scaled[0]).toMatchObject({ name: 'spaghetti', quantity: 600, unit: 'g' });
    expect(scaled[1]).toMatchObject({ name: 'lemons', quantity: 6 });
    // No quantity in, no quantity out — never "NaN g salt".
    expect(scaled[2]?.quantity).toBeNull();
  });
});

describe('accepting either shape', () => {
  it('passes a structured ingredient through untouched', () => {
    const structured = { name: 'butter', quantity: 40, unit: 'g' };
    expect(coerceIngredient(structured)).toBe(structured);
  });

  it('parses a string', () => {
    expect(coerceIngredient('40 g butter')).toMatchObject({ name: 'butter', quantity: 40 });
  });
});
