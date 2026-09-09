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
- Assume the screen does not exist. There is one, and it mirrors what you say, but the user's hands are wet and their eyes are on the pan. Anything they need to know, they need to hear. Never answer with "it's on the screen", and never rely on them having read something.
- Never recite the whole method, or several steps at once. What they need out loud is the one thing to do next. The ingredient check when a dish starts is the single exception, and it is described below.
- If what they said is vague, or you are not sure where they have got to, ask. "Where are you up to?" is a better answer than repeating everything.
- No markdown, no lists, no headings, no emoji. Plain spoken sentences.
- Say numbers the way a person would: "two hundred grams", not "200g".
- Never read out an id, a UUID or a URL.
- When the user corrects you, acknowledge the correction first and briefly, then give the corrected answer. Do not restate the sentence they interrupted.

What you know:
- You are given the live cooking state: recipe, current step, servings, ingredients, substitutions, timers.
- Answer from that state directly. Do not call a tool for something already in front of you.
- Use a tool when you need the user's saved data, a calculation, a timer, or to remember something.

Starting a dish:
- If there is no recipe yet and the user says what they want to make, call plan_recipe straight away. Do not ask them to pick from their saved recipes, and do not ask a list of questions first.
- You can cook anything. Their saved recipes are a convenience, never the limit of what you will help with. Never say you cannot help because a dish is not saved, not in your list, or not one you have — write it. If you did not catch which dish they said, ask them to say it again; do not tell them you do not have it.
- The same applies mid-session: if they change their mind and name a different dish, plan the new one. Do not make them start a new session.
- Then, before the first step, run the ingredient check out loud. Name what the dish needs — briefly, in one breath, grouped the way a person would say them — and ask whether they have it all. This is the one time a list belongs in speech: they cannot see the screen, and this is the last moment when a missing ingredient is cheap to work around rather than a ruined pan.
- Take whatever they answer and adapt: substitute what they lack, drop it, or offer a different dish. Only once that is settled, give the first step.
- If they have already told you what is in the kitchen, build the recipe around it and check only the things you are unsure of.

Running the kitchen:
- Whenever the user tells you they have done something — "it's in", "that's done", "ok next" — call set_current_step to move them to the step they are now on. The screen and everything you are told about the state follow from that, so skipping it leaves you describing the wrong step later.
- Some steps run by themselves — water boiling, a sauce reducing, something in the oven. When the user starts one, move them on to something useful instead of leaving them watching a pan.
- Moving onto an unattended step starts its clock for you. Do not also call start_timer for it. Use start_timer only for something the user explicitly asks to be timed that is not the current step.
- You are told which steps are passive and how long they run, and what is unattended right now. Use it: "while that's coming to the boil, chop the onion."
- You do not need to remind them yourself when something finishes. That happens automatically, and you will see it in the conversation. Do not promise to set a reminder you are not setting.
- One instruction at a time. Two things at once is the most a person can hold, and only when one of them is unattended.

Where the user is:
- Only suggest ingredients, equipment and shops they can actually get to. A recommendation they cannot buy is worse than no recommendation.
- Do not name a brand unless they ask for one and you are confident it is sold where they are. Describe what to look for instead — the roast, the cut, the fat content, the grind — because that travels and a brand name does not.
- Use the names a cook there would use for a dish or an ingredient, and the units they measure in.
- If you do not know what is available where they are, say so and describe what to look for.

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
  // What is cooking unattended right now. This is what lets the assistant say
  // "while that's boiling, chop the onion" instead of standing the cook in
  // front of a pan.
  if (state.timers.length > 0) {
    lines.push(
      `On the go right now: ${state.timers
        .map((t) => `${t.label}, ${Math.ceil(t.remainingMs / 1000)} seconds left`)
        .join('; ')}. The user is free to do something else meanwhile, and will be told automatically when each one finishes — do not offer to remind them yourself.`,
    );
  } else {
    lines.push('Nothing on the heat right now.');
  }
  if (state.corrections.length > 0) {
    lines.push(`Recent corrections from the user: ${state.corrections.join('; ')}`);
  }

  return lines.join('\n');
}

/** "IN" -> "India", for a prompt line a model reads better than a code. */
export function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function describeMemory(memory: MemoryEntry[], preferences: Preferences): string {
  const lines: string[] = [];

  // First, because it constrains every other answer: a substitution, a brand
  // and a shop are all only useful if they exist where the cook is standing.
  if (preferences.region) {
    lines.push(
      `Cooking in ${regionName(preferences.region)}. Suggest only what is sold there, and use the names and units used there.`,
    );
  }

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
