import { z } from 'zod';
import { moveToStep, patchSession } from '../cooking/state';
import { saveMemory } from '../db/memory';
import { updatePreferences } from '../db/profiles';
import { defineTool, jsonSchema } from './types';

export const setCurrentStepTool = defineTool({
  name: 'set_current_step',
  description:
    'Move the cook forward or back in the recipe. Use when the user says they have finished a step, wants the next one, or wants to go back. Step numbers are 1-based.',
  schema: z.object({ step: z.number().int().min(1).max(200) }),
  parameters: jsonSchema(
    { step: jsonSchema.integer('The step number to move to, counting from 1.') },
    ['step'],
  ),
  // No filler: this is a local state change and returns before a filler would
  // finish playing. Speaking one here would add latency, not remove it.
  filler: [],
  async execute(args, ctx) {
    const session = await moveToStep(ctx.db, ctx.state, args.step - 1);
    const steps = ctx.state.recipe?.steps ?? [];
    return {
      stateChanged: true,
      data: {
        current_step: session.currentStep + 1,
        total_steps: steps.length,
        step_text: steps[session.currentStep] ?? null,
      },
    };
  },
});

export const saveUserPreferenceTool = defineTool({
  name: 'save_user_preference',
  description:
    "Remember something durable about the signed-in user for future cooking sessions: a taste, an avoidance, how many people they usually cook for. Do not use it for anything that is only true of the current recipe.",
  schema: z.object({
    key: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(500),
    kind: z.enum(['preference', 'avoidance', 'note']).default('preference'),
  }),
  parameters: jsonSchema(
    {
      key: jsonSchema.string('Short stable key, such as "spice_level" or "usual_servings".'),
      value: jsonSchema.string('The value in the user\'s own terms, such as "not very spicy".'),
      kind: {
        type: 'string',
        enum: ['preference', 'avoidance', 'note'],
        description: 'avoidance for allergies and dislikes, preference for tastes, note otherwise.',
      },
    },
    ['key', 'value'],
  ),
  filler: [],
  async execute(args, ctx) {
    const entry = await saveMemory(ctx.db, args.key, args.value, args.kind);

    // A few keys also have a structured home, because they are read on every
    // turn and benefit from a fixed shape rather than a text lookup.
    if (/serving|portion|people/.test(entry.key)) {
      const parsed = Number.parseInt(entry.value.replace(/\D+/g, ''), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
        await updatePreferences(ctx.db, { defaultServings: parsed });
      }
    }

    return { data: { saved: true, key: entry.key, value: entry.value } };
  },
});

export const closeRecipeTool = defineTool({
  name: 'close_recipe',
  description:
    "Put the current dish away and leave the session empty and ready for the next one. Use when the user says they are done, finished, stopping, or wants to cook something else instead — 'that's done', 'stop the recipe', 'close this', 'forget this one'. The recipe itself is kept in their saved recipes; only this session lets go of it.",
  schema: z.object({}),
  parameters: jsonSchema({}, []),
  // Local state change, back before a filler would finish.
  filler: [],
  async execute(_args, ctx) {
    const closed = ctx.state.recipe;
    if (!closed) {
      return { data: { closed: false, reason: 'nothing_in_progress', note: 'No dish is in progress.' } };
    }

    /*
     * The recipe is detached, not deleted. It was written for this cook and
     * stays in their saved recipes; what ends is this session's hold on it, so
     * the next thing they name can be planned without the guard that stops a
     * dish in progress being overwritten.
     */
    await patchSession(ctx.db, ctx.state.session.id, {
      recipeId: null,
      currentStep: 0,
      notes: { ...ctx.state.session.notes, corrections: [] },
    });

    return {
      stateChanged: true,
      data: {
        closed: true,
        was: closed.title,
        note: 'The session is empty again and saved. Ask what they would like to cook next, briefly.',
      },
    };
  },
});
