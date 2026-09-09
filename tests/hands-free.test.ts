import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, describeState } from '@/lib/llm/prompt';
import { buildSnapshot } from '@/lib/cooking/state';
import type { CookingSession } from '@/lib/types';

/**
 * The instructions a cook actually depends on, asserted rather than trusted.
 *
 * These are not style checks. Each one is a behaviour that was reported from a
 * real session and is invisible in every other test, because the model is not
 * run here: a prompt can lose a rule in an edit and nothing else notices until
 * someone is standing over a pan being told the answer is on a screen they
 * cannot look at.
 */

const EMPTY_SESSION: CookingSession = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  recipeId: null,
  currentStep: 0,
  status: 'active',
  notes: {},
  createdAt: '2026-09-09T10:00:00.000Z',
  updatedAt: '2026-09-09T10:00:00.000Z',
};

describe('it will cook anything, not only what is saved', () => {
  /*
   * Reported: asked for white sauce chicken pasta and was told it could not
   * help because that is not a saved recipe. The saved recipes are a
   * convenience; refusing on their account contradicts the entire product.
   */
  it('forbids refusing a dish for not being saved', () => {
    expect(SYSTEM_PROMPT).toMatch(/You can cook anything/i);
    expect(SYSTEM_PROMPT).toMatch(/never the limit/i);
    expect(SYSTEM_PROMPT).toMatch(/Never say you cannot help because a dish is not saved/i);
  });

  it('sends a misheard dish back for a repeat rather than a refusal', () => {
    // The failure this prevents: a garbled transcript becoming "I don't have
    // that recipe", which sounds like a refusal and ends the conversation.
    expect(SYSTEM_PROMPT).toMatch(/ask them to say it again/i);
    expect(SYSTEM_PROMPT).toMatch(/do not tell them you do not have it/i);
  });

  it('plans a new dish mid-session instead of demanding a fresh start', () => {
    expect(SYSTEM_PROMPT).toMatch(/if they change their mind and name a different dish/i);
  });

  it('tells the model to plan the moment a dish is named, in an empty session', () => {
    const description = describeState(buildSnapshot(EMPTY_SESSION, null, []));
    expect(description).toMatch(/plan_recipe/);
  });
});

describe('everything the cook needs is spoken', () => {
  /*
   * Reported: "it has to be a hands free tool, everything shd be verbal".
   * The prompt used to point at the screen as the place recipes live, which is
   * exactly wrong for someone with both hands in a bowl.
   */
  it('does not treat the screen as somewhere the user can be sent', () => {
    expect(SYSTEM_PROMPT).toMatch(/Assume the screen does not exist/i);
    expect(SYSTEM_PROMPT).toMatch(/they need to hear/i);
    // The old wording, which excused not saying things out loud.
    expect(SYSTEM_PROMPT).not.toMatch(/The user has a screen for that/i);
  });

  it('opens a dish by asking out loud which ingredients they have', () => {
    expect(SYSTEM_PROMPT).toMatch(/ingredient check/i);
    expect(SYSTEM_PROMPT).toMatch(/ask whether they have it all/i);
    // Before the first step, or the cook discovers the gap with a hot pan.
    expect(SYSTEM_PROMPT).toMatch(/before the first step/i);
  });

  it('still forbids reciting the method, which is what made lists a problem', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never recite the whole method/i);
    expect(SYSTEM_PROMPT).toMatch(/one thing to do next/i);
  });

  it('adapts to what they answer instead of ploughing on', () => {
    expect(SYSTEM_PROMPT).toMatch(/substitute what they lack/i);
  });
});

describe('how many people it is for', () => {
  /*
   * Reported: "it shd ask me stuff about how many ppl this is for for accurate
   * measurements". Every quantity depends on it, and scaling afterwards is too
   * late for someone who has already measured.
   */
  it('settles the number before writing the recipe', () => {
    expect(SYSTEM_PROMPT).toMatch(/settle how many people it is for/i);
    expect(SYSTEM_PROMPT).toMatch(/before you write it/i);
  });

  it('offers the number it already knows rather than asking cold', () => {
    expect(SYSTEM_PROMPT).toMatch(/as usual/i);
    const described = describeState(buildSnapshot(EMPTY_SESSION, null, []));
    expect(described).toMatch(/how many people it is for/i);
    expect(described).toMatch(/If not, ask/i);
  });

  it('never presents the fallback serving count as something the user said', () => {
    // buildSnapshot falls back to two when no recipe and no note exist. That
    // number is an assumption, and quoting it back as "your usual" would be
    // the assistant inventing a preference and then cooking to it.
    const described = describeState(buildSnapshot(EMPTY_SESSION, null, []));
    expect(described).not.toMatch(/usual is 2|usually cooks for 2|2, as usual/i);
  });
});
