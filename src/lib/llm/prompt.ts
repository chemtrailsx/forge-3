import { formatIngredient } from '../cooking/scale';
import type { Preferences } from '../db/profiles';
import type { ConversationTurn, CookingStateSnapshot, MemoryEntry } from '../types';
import type { ChatMessage } from './types';

/**
 * Prompt construction.
 *
 * Everything the model sees is assembled here, from data that was already
 * scoped to the authenticated user by the layer below. There is no path by
 * which another user's row reaches this function.
 *
 * The system prompt is written for speech: the output is going to a speaker in
 * a kitchen, so length, digits and formatting are constraints, not style
 * preferences.
 */

const SYSTEM_PROMPT = `You are Cooking Companion, a hands-free cooking assistant. The user is cooking right now and cannot look at a screen. Everything you say is spoken aloud.

How to speak:
- Two or three short sentences at most. One is usually better.
- No markdown, no lists, no headings, no emoji. Plain spoken sentences.
- Say numbers the way a person would: "two hundred grams", not "200g".
- Never read out an id, a UUID or a URL.
- When the user corrects you, acknowledge the correction first and briefly, then give the corrected answer. Do not restate the sentence they interrupted.

What you know:
- You are given the live cooking state: recipe, current step, servings, ingredients, substitutions, timers.
- Answer from that state directly. Do not call a tool for something already in front of you.
- Use a tool when you need the user's saved data, a calculation, a timer, or to remember something.

Starting a dish:
- If there is no recipe yet and the user says what they want to make, call plan_recipe straight away. Do not ask them to pick from their saved recipes, and do not ask a list of questions first — one clarifying question at most, and only if you genuinely cannot proceed.
- Build the recipe around what they say they have and skip what they say they lack. If they mention a missing ingredient later, adapt rather than starting over.
- After planning, say the dish and the first step. Never read the whole method out.

Running the kitchen:
- Some steps run by themselves — water boiling, a sauce reducing, something in the oven. When the user starts one, move them on to something useful instead of leaving them watching a pan.
- You are told which steps are passive and how long they run, and what is unattended right now. Use it: "while that's coming to the boil, chop the onion."
- You do not need to remind them yourself when something finishes. That happens automatically, and you will see it in the conversation. Do not promise to set a reminder you are not setting.
- One instruction at a time. Two things at once is the most a person can hold, and only when one of them is unattended.

Honesty:
- If a tool reports it has no answer, say so plainly. Never invent a substitution ratio, a cooking time or a quantity.
- Never claim a tool result before the tool has returned it.
- For meat, poultry, fish and eggs, never give a time as proof it is done. Give the temperature or the visual check that settles it, and say the time is a guide.`;

export type PromptInput = {
  state: CookingStateSnapshot;
  memory: MemoryEntry[];
  preferences: Preferences;
  history: ConversationTurn[];
  utterance: string;
};

export function describeState(state: CookingStateSnapshot): string {
  if (state.awaitingRecipe) {
    return [
      'No dish chosen yet. This session is empty.',
      'The moment the user says what they want to cook, call plan_recipe.',
      state.servings ? `They appear to be cooking for ${state.servings}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const attention = (step: { attention: 'active' | 'passive' } | null) =>
    step?.attention === 'passive' ? ' (runs by itself — send them off to do something else)' : '';

  const lines: string[] = [
    `Recipe: ${state.title}`,
    state.totalSteps > 0
      ? `Step ${state.currentStep + 1} of ${state.totalSteps}: ${state.currentStepText ?? '(none)'}${attention(state.currentStepDetail)}`
      : 'No steps recorded for this recipe.',
  ];

  if (state.nextStepText) {
    lines.push(`Next step: ${state.nextStepText}${attention(state.nextStepDetail)}`);
  }
  lines.push(
    `Cooking for ${state.servings} ${state.servings === 1 ? 'person' : 'people'}` +
      (state.servings !== state.baseServings ? ` (recipe is written for ${state.baseServings})` : ''),
  );

  if (state.ingredients.length > 0) {
    lines.push(`Ingredients at this serving size: ${state.ingredients.map(formatIngredient).join('; ')}`);
  }
  if (state.substitutions.length > 0) {
    lines.push(
      `Substitutions in use: ${state.substitutions.map((s) => `${s.from} replaced by ${s.to}`).join('; ')}`,
    );
  }
  if (state.timers.length > 0) {
    lines.push(
      `Running timers: ${state.timers
        .map((t) => `${t.label}, ${Math.ceil(t.remainingMs / 1000)} seconds left`)
        .join('; ')}`,
    );
  } else {
    lines.push('Running timers: none.');
  }

  // What is cooking unattended right now. This is what lets the assistant say
  // "while that's boiling, chop the onion" instead of standing the cook in
  // front of a pan.
  if (state.running.length > 0) {
    lines.push(
      `Unattended right now: ${state.running
        .map((t) => `${t.label}, ${Math.ceil(t.remainingMs / 60_000)} minutes left`)
        .join('; ')}. The user is free to do something else meanwhile, and will be told automatically when each is done.`,
    );
  }
  if (state.corrections.length > 0) {
    lines.push(`Recent corrections from the user: ${state.corrections.join('; ')}`);
  }

  return lines.join('\n');
}

function describeMemory(memory: MemoryEntry[], preferences: Preferences): string {
  const lines: string[] = [];

  if (preferences.defaultServings) lines.push(`Usually cooks for ${preferences.defaultServings}.`);
  if (preferences.spiceLevel) lines.push(`Prefers ${preferences.spiceLevel} spice.`);
  if (preferences.dietary?.length) lines.push(`Dietary: ${preferences.dietary.join(', ')}.`);

  for (const entry of memory) {
    lines.push(`${entry.kind === 'avoidance' ? 'Avoids' : 'Notes'} — ${entry.key.replace(/_/g, ' ')}: ${entry.value}`);
  }

  return lines.length > 0
    ? lines.join('\n')
    : 'Nothing saved about this user yet.';
}

/**
 * History uses `heardText` wherever a turn was interrupted.
 *
 * This is the whole point of storing the two separately: if the assistant was
 * cut off saying "Drain the pasta and—", the model must see only what reached
 * the user's ears, marked as cut off. Replaying its full intended sentence is
 * what makes an interrupted agent refer back to advice nobody ever heard.
 */
export function historyToMessages(history: ConversationTurn[]): ChatMessage[] {
  return history.map((turn) => {
    if (turn.role === 'user') return { role: 'user' as const, content: turn.text };
    const spoken = turn.interrupted ? (turn.heardText ?? '') : turn.text;
    return {
      role: 'assistant' as const,
      content: turn.interrupted ? `${spoken} —(cut off by the user here)` : spoken,
    };
  });
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Live cooking state:\n${describeState(input.state)}\n\nWhat you remember about this user:\n${describeMemory(input.memory, input.preferences)}`,
    },
    ...historyToMessages(input.history),
    { role: 'user', content: input.utterance },
  ];
}

export { SYSTEM_PROMPT };
