import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  clampStep,
  describeStep,
  loadCookingState,
  moveToStep,
  recordCorrection,
  recordSubstitution,
  setServings,
} from '@/lib/cooking/state';
import { formatIngredient, scaleIngredients, scaleQuantity } from '@/lib/cooking/scale';
import { findSubstitution } from '@/lib/cooking/substitutions';
import { toView } from '@/lib/db/timers';
import { ALICE, ALICE_SESSION, makeDb, seedTables } from './helpers/fixtures';
import type { CookingSession, Recipe, TimerRecord } from '@/lib/types';

const RECIPE: Recipe = {
  id: 'r1',
  userId: ALICE,
  title: 'Test pasta',
  servings: 2,
  isFavorite: false,
  source: null,
  createdAt: '',
  ingredients: [
    { name: 'spaghetti', quantity: 200, unit: 'g' },
    { name: 'garlic', quantity: 3, unit: 'cloves' },
    { name: 'salt', quantity: null, unit: null, note: 'to taste' },
  ],
  steps: [
    // A passive step in the middle, because that is the case the parallel
    // logic exists for: the cook is free while the pasta boils.
    { text: 'Boil water.', durationSeconds: null, attention: 'active' },
    { text: 'Cook pasta.', durationSeconds: 480, attention: 'passive' },
    { text: 'Serve.', durationSeconds: null, attention: 'active' },
  ],
};

const SESSION: CookingSession = {
  id: 's1',
  userId: ALICE,
  recipeId: 'r1',
  currentStep: 1,
  status: 'active',
  notes: {},
  createdAt: '',
  updatedAt: '',
};

describe('scaling', () => {
  it('rounds grams to something a cook can measure', () => {
    expect(scaleQuantity(200, 3 / 2, 'g')).toBe(300);
    // 200 * 4/3 = 266.67 -> 265, not 266.6666.
    expect(scaleQuantity(200, 4 / 3, 'g')).toBe(265);
    expect(scaleQuantity(40, 1.5, 'g')).toBe(60);
  });

  it('keeps countable ingredients whole', () => {
    expect(scaleQuantity(3, 0.5, 'cloves')).toBe(2);
    expect(scaleQuantity(1, 0.25, 'eggs')).toBe(1);
  });

  it('leaves "to taste" ingredients alone', () => {
    const scaled = scaleIngredients(RECIPE.ingredients, 2, 6);
    expect(scaled[2]?.quantity).toBeNull();
    expect(formatIngredient(scaled[2]!)).toBe('salt, to taste');
  });

  it('refuses a nonsensical serving count instead of dividing by zero', () => {
    expect(() => scaleIngredients(RECIPE.ingredients, 0, 4)).toThrow(RangeError);
    expect(() => scaleIngredients(RECIPE.ingredients, 2, 0)).toThrow(RangeError);
  });
});

describe('snapshot', () => {
  it('exposes the current and next step', () => {
    const snapshot = buildSnapshot(SESSION, RECIPE, []);
    expect(snapshot.currentStepText).toBe('Cook pasta.');
    expect(snapshot.nextStepText).toBe('Serve.');
  });

  it('scales ingredients when the session serving count differs', () => {
    const snapshot = buildSnapshot({ ...SESSION, notes: { servings: 4 } }, RECIPE, []);
    expect(snapshot.servings).toBe(4);
    expect(snapshot.baseServings).toBe(2);
    expect(snapshot.ingredients[0]?.quantity).toBe(400);
  });

  it('survives a session with no recipe attached', () => {
    const snapshot = buildSnapshot({ ...SESSION, recipeId: null }, null, []);
    expect(snapshot.totalSteps).toBe(0);
    expect(snapshot.currentStepText).toBeNull();
    expect(snapshot.ingredients).toEqual([]);
  });

  it('clamps steps to the recipe', () => {
    expect(clampStep(-3, 3)).toBe(0);
    expect(clampStep(9, 3)).toBe(2);
    expect(clampStep(1, 0)).toBe(0);
  });
});

/** A running timer, with only the fields a test cares about overridden. */
function timerRecord(overrides: Partial<TimerRecord> = {}): TimerRecord {
  return {
    id: 't',
    label: 'pasta',
    durationMs: 480_000,
    startedAt: new Date().toISOString(),
    status: 'running',
    kind: 'timer',
    stepIndex: null,
    headsUpAt: null,
    remindedAt: null,
    ...overrides,
  };
}

describe('timers', () => {
  it('derives remaining time from the start instant, not a stored counter', () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const view = toView(timerRecord({ startedAt }));

    expect(view.remainingMs).toBeGreaterThan(400_000);
    expect(view.remainingMs).toBeLessThanOrEqual(420_000);
    expect(view.expired).toBe(false);
  });

  it('reports an elapsed timer as expired rather than negative', () => {
    const startedAt = new Date(Date.now() - 900_000).toISOString();
    const view = toView(timerRecord({ startedAt }));
    expect(view.remainingMs).toBe(0);
    expect(view.expired).toBe(true);
  });
});

describe('persistent state across a turn', () => {
  it('remembers step, servings, substitutions and corrections', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    let state = await loadCookingState(db, ALICE_SESSION);
    await moveToStep(db, state, 2);

    state = await loadCookingState(db, ALICE_SESSION);
    await setServings(db, state, 4);

    state = await loadCookingState(db, ALICE_SESSION);
    await recordSubstitution(db, state, { from: 'butter', to: 'olive oil', note: '3 to 4' });

    state = await loadCookingState(db, ALICE_SESSION);
    await recordCorrection(db, state, "Wait, I haven't added the salt.");

    const final = await loadCookingState(db, ALICE_SESSION);
    expect(final.snapshot.currentStep).toBe(2);
    expect(final.snapshot.servings).toBe(4);
    expect(final.snapshot.substitutions).toHaveLength(1);
    expect(final.snapshot.corrections).toEqual(["Wait, I haven't added the salt."]);
    // Scaling must be reflected in the ingredient list the assistant reads from.
    expect(final.snapshot.ingredients[0]?.quantity).toBe(400);
  });

  it('replaces rather than accumulates a substitution for the same ingredient', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    let state = await loadCookingState(db, ALICE_SESSION);
    await recordSubstitution(db, state, { from: 'butter', to: 'olive oil', note: '' });
    state = await loadCookingState(db, ALICE_SESSION);
    await recordSubstitution(db, state, { from: 'Butter', to: 'ghee', note: '1 to 1' });

    const final = await loadCookingState(db, ALICE_SESSION);
    expect(final.snapshot.substitutions).toHaveLength(1);
    expect(final.snapshot.substitutions[0]?.to).toBe('ghee');
  });

  it('keeps only the most recent corrections', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    for (let i = 0; i < 8; i += 1) {
      const state = await loadCookingState(db, ALICE_SESSION);
      await recordCorrection(db, state, `correction ${i}`);
    }

    const final = await loadCookingState(db, ALICE_SESSION);
    expect(final.snapshot.corrections).toHaveLength(5);
    expect(final.snapshot.corrections.at(-1)).toBe('correction 7');
  });
});

describe('naming a step for a spoken reminder', () => {
  /**
   * This string is read aloud in "Your ___ should be ready now", so it has to
   * be the thing being cooked, not the instruction repeated back.
   */
  it('reduces an instruction to the thing it produces', () => {
    expect(describeStep('Add the spaghetti and cook for eight minutes, stirring once')).toBe(
      'spaghetti',
    );
    expect(describeStep('Simmer the sauce for forty minutes')).toBe('sauce');
    expect(describeStep('Roast the chicken for seventy-five minutes until the juices run clear')).toBe(
      'chicken',
    );
  });

  it('never leaves an article that would double up after "your"', () => {
    for (const step of [
      'Add the spaghetti and cook for eight minutes',
      'Boil a large pan of water',
      'Put some rice on to steam for twenty minutes',
    ]) {
      expect(describeStep(step)).not.toMatch(/^(the|a|an|some|your)\b/i);
    }
  });

  it('falls back to something sayable rather than an empty string', () => {
    expect(describeStep('')).toBe('that');
    expect(describeStep('Wait')).toBe('Wait');
  });
});

describe('parallel work', () => {
  it('starts the clock by itself when the cook reaches an unattended step', async () => {
    const tables = seedTables();
    // Step 2 of the seeded pasta is "cook for eight minutes" — give it the
    // structure a planned recipe would have.
    const recipe = tables.recipes?.find((row) => row.id === 'aaaaaaaa-0000-4000-8000-000000000001');
    recipe!.steps = [
      { text: 'Bring a pan of water to the boil.', attention: 'active' },
      { text: 'Add the spaghetti and cook for eight minutes.', duration_seconds: 480, attention: 'passive' },
      { text: 'Drain and serve.', attention: 'active' },
    ];

    const { db } = makeDb(ALICE, tables);
    const state = await loadCookingState(db, ALICE_SESSION);
    await moveToStep(db, state, 1);

    const after = await loadCookingState(db, ALICE_SESSION);
    // Nobody asked for a timer. The cook said "it's in" and walked away, which
    // is the whole point: the thing being watched is the thing nobody watches.
    expect(after.snapshot.running).toHaveLength(1);
    expect(after.snapshot.running[0]?.label).toBe('spaghetti');
    expect(after.snapshot.running[0]?.stepIndex).toBe(1);
    expect(after.snapshot.running[0]?.kind).toBe('step');
  });

  it('does not start a second clock for a step already running', async () => {
    const tables = seedTables();
    const recipe = tables.recipes?.find((row) => row.id === 'aaaaaaaa-0000-4000-8000-000000000001');
    recipe!.steps = [
      { text: 'Boil water.', attention: 'active' },
      { text: 'Cook the pasta for eight minutes.', duration_seconds: 480, attention: 'passive' },
    ];

    const { db } = makeDb(ALICE, tables);
    await moveToStep(db, await loadCookingState(db, ALICE_SESSION), 1);
    await moveToStep(db, await loadCookingState(db, ALICE_SESSION), 1);

    const after = await loadCookingState(db, ALICE_SESSION);
    expect(after.snapshot.running).toHaveLength(1);
  });

  it('leaves an active step alone', async () => {
    const tables = seedTables();
    const recipe = tables.recipes?.find((row) => row.id === 'aaaaaaaa-0000-4000-8000-000000000001');
    recipe!.steps = [{ text: 'Chop the onion.', attention: 'active' }];

    const { db } = makeDb(ALICE, tables);
    await moveToStep(db, await loadCookingState(db, ALICE_SESSION), 0);

    const after = await loadCookingState(db, ALICE_SESSION);
    expect(after.snapshot.running).toHaveLength(0);
  });
});

describe('a session with no dish yet', () => {
  it('reports that it is waiting rather than pretending to have a recipe', () => {
    const snapshot = buildSnapshot({ ...SESSION, recipeId: null }, null, []);
    expect(snapshot.awaitingRecipe).toBe(true);
    expect(snapshot.totalSteps).toBe(0);
    expect(snapshot.currentStepDetail).toBeNull();
  });

  it('stops awaiting once a recipe is attached', () => {
    expect(buildSnapshot(SESSION, RECIPE, []).awaitingRecipe).toBe(false);
  });
});

describe('substitution table', () => {
  it('matches aliases and partial phrasing', () => {
    expect(findSubstitution('salted butter')?.ingredient).toBe('butter');
    expect(findSubstitution('Parmigiano Reggiano')?.ingredient).toBe('parmesan');
    expect(findSubstitution('red pepper flakes')?.ingredient).toBe('chilli flakes');
  });

  it('returns nothing for an ingredient it has no verified answer for', () => {
    expect(findSubstitution('saffron')).toBeNull();
    expect(findSubstitution('')).toBeNull();
  });
});
