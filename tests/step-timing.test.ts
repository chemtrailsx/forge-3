import { describe, expect, it } from 'vitest';
import { extractDurationSeconds, inferStepTiming } from '@/lib/cooking/step-timing';
import { stepsSchema } from '@/lib/validation';
import { parseIngredient } from '@/lib/cooking/parse-ingredient';

/**
 * Every step string here was written by the live model during a real session.
 * It marked the boiling pasta `active` with no duration and the oil in a
 * skillet `passive` — understanding the parallelism in prose (the next step it
 * wrote began "while the pasta cooks") while getting the field wrong.
 *
 * That is why the text decides. These are the cases that have actually failed.
 */

describe('finding the duration in an instruction', () => {
  it('reads a plain duration', () => {
    expect(extractDurationSeconds('Simmer the sauce gently for seven minutes.')).toBe(420);
    expect(extractDurationSeconds('Roast for 75 minutes.')).toBe(4500);
    expect(extractDurationSeconds('Rest for 1 hour.')).toBe(3600);
    expect(extractDurationSeconds('Blanch for 30 seconds.')).toBe(30);
  });

  it('reads a duration buried mid-sentence', () => {
    expect(
      extractDurationSeconds('Add a pinch of salt and the spaghetti, cooking until al dente, about 9 minutes.'),
    ).toBe(540);
  });

  it('takes the lower bound of a range, so the cook checks early', () => {
    expect(extractDurationSeconds('Cook for 8 to 10 minutes.')).toBe(480);
    expect(extractDurationSeconds('Bake for 25-30 minutes.')).toBe(1500);
    expect(extractDurationSeconds('Simmer for eight to ten minutes.')).toBe(480);
  });

  it('finds nothing when there is no duration', () => {
    expect(extractDurationSeconds('Heat the olive oil in a skillet over medium heat.')).toBeNull();
    expect(extractDurationSeconds('Drain the pasta, reserving a cup of cooking water.')).toBeNull();
    // "medium heat" must not be mistaken for a quantity of time.
    expect(extractDurationSeconds('Cook over medium heat.')).toBeNull();
  });
});

describe('deciding whether the cook can walk away', () => {
  it('overrides the model when the text says otherwise', () => {
    // The exact step the model got wrong, with the exact label it gave it.
    const timing = inferStepTiming(
      'Add a pinch of salt and the spaghetti, cooking until al dente, about 9 minutes.',
      { durationSeconds: null, attention: 'active' },
    );
    expect(timing.attention).toBe('passive');
    expect(timing.durationSeconds).toBe(540);
  });

  it('marks a simmer passive', () => {
    expect(inferStepTiming('Simmer the sauce gently for seven minutes.')).toEqual({
      durationSeconds: 420,
      attention: 'passive',
    });
  });

  it('keeps a step active when the duration is spent working', () => {
    // Three minutes of stirring is three minutes of work, not of freedom.
    expect(
      inferStepTiming('Cook the roux, stirring constantly, for three minutes.').attention,
    ).toBe('active');
  });

  it('keeps a short wait active, because a reminder that soon is noise', () => {
    expect(inferStepTiming('Toast the spices for 30 seconds.').attention).toBe('active');
  });

  it('leaves a step with no duration alone', () => {
    expect(inferStepTiming('Drain the pasta, reserving a cup of cooking water.')).toEqual({
      durationSeconds: null,
      attention: 'active',
    });
  });

  it('errs towards passive, because a missed reminder is the worse failure', () => {
    // Wrongly passive costs one unwanted reminder. Wrongly active means the
    // pan boils over in silence.
    expect(inferStepTiming('Let it bubble away for twelve minutes.').attention).toBe('passive');
  });
});

describe('normalising a planned recipe', () => {
  it('corrects the model\'s labelling as the steps are stored', () => {
    const steps = stepsSchema.parse([
      { text: 'Bring a large pot of water to a boil.', attention: 'active' },
      {
        text: 'Add a pinch of salt and the spaghetti, cooking until al dente, about 9 minutes.',
        attention: 'active',
      },
      { text: 'Simmer the sauce gently for seven minutes.', duration_seconds: 420, attention: 'passive' },
      { text: 'Serve the pasta hot.', attention: 'active' },
    ]);

    // The pasta is the thing that must be watched, and the model said active.
    expect(steps[1]).toMatchObject({ attention: 'passive', durationSeconds: 540 });
    expect(steps[2]).toMatchObject({ attention: 'passive', durationSeconds: 420 });
    expect(steps[3]).toMatchObject({ attention: 'active', durationSeconds: null });
  });

  it('still accepts a plain string step from an older recipe', () => {
    const steps = stepsSchema.parse([
      'Add the spaghetti and cook for eight minutes, stirring once at the start.',
      'Drain and serve.',
    ]);
    expect(steps[0]).toMatchObject({ attention: 'passive', durationSeconds: 480 });
    expect(steps[1]).toMatchObject({ attention: 'active' });
  });
});

describe('an article between a quantity and its unit', () => {
  it('does not become part of the ingredient name', () => {
    // The live model wrote "half a teaspoon black pepper", which parsed to an
    // ingredient literally called "a teaspoon black pepper".
    expect(parseIngredient('half a teaspoon black pepper')).toEqual({
      name: 'black pepper',
      quantity: 0.5,
      unit: 'tsp',
    });
    expect(parseIngredient('a quarter of a cup of milk')).toMatchObject({
      quantity: 0.25,
      unit: 'cup',
    });
  });

  it('leaves a genuine "a" in a name alone', () => {
    expect(parseIngredient('1 a-grade egg').name).toBe('a-grade egg');
  });
});
