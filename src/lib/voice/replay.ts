/**
 * Recognising "say that again".
 *
 * Handled in the browser, before the turn pipeline, and deliberately not by
 * the model. Three reasons, and they all matter in a kitchen:
 *
 *  - It replays *exactly* what was said. Asking the model to repeat itself
 *    produces a paraphrase, and someone who missed a quantity needs the
 *    quantity, not a second attempt at the sentence.
 *  - It is instant and free. The audio is already in memory; a turn would cost
 *    a recognition call, a model call and a synthesis call to say something it
 *    has already said.
 *  - It cannot fail differently. A missed instruction is exactly the moment
 *    the cook is least able to cope with a new answer.
 *
 * The matching is tight on purpose. "Repeat that" is a replay; "can you repeat
 * that but slower" is a request the model should handle, because it is asking
 * for something different from what it already produced.
 */

const REPLAY_PHRASES = [
  'again',
  'say that again',
  'say it again',
  'repeat',
  'repeat that',
  'repeat it',
  'come again',
  'what did you say',
  'what was that',
  'i missed that',
  'i did not catch that',
  "i didn't catch that",
  'sorry what',
  'pardon',
  'one more time',
  'play that again',
  'read that again',
  'what did i miss',
];

/** Words that mean "not simply a repeat" — a different answer is wanted. */
const MODIFIERS =
  /\b(slower|slowly|faster|louder|quieter|simpler|shorter|in|but|except|without|instead|step|again from|next|first|last)\b/i;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Politeness that changes nothing about the request. Only whole trailing
    // courtesy words: an earlier version allowed " again please" as one unit,
    // and the alternation then ate "again" — the only meaningful word in
    // "say that again please".
    .replace(/^(hey |ok |okay |um |uh |please |sorry )+/g, '')
    .replace(/(\s+(please|sorry|thanks|thank you))+$/g, '')
    .trim();
}

export function isReplayRequest(text: string): boolean {
  const normalised = normalise(text);
  if (!normalised) return false;

  // A long sentence is a question, not a request to hear the last one back.
  const words = normalised.split(' ');
  if (words.length > 6) return false;

  // "say that again but slower" wants something the model has not produced.
  if (MODIFIERS.test(normalised)) return false;

  if (REPLAY_PHRASES.includes(normalised)) return true;

  // "could you say that again" — allow a leading politeness clause.
  const stripped = normalised.replace(
    /^(can you|could you|would you|will you|can we|please)\s+/,
    '',
  );
  return REPLAY_PHRASES.includes(stripped);
}
