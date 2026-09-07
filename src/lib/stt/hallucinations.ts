/**
 * Filters the phrases Whisper produces when handed silence.
 *
 * Given near-silence or room noise, Whisper does not return an empty string —
 * it returns the most common thing said at the end of the audio it was trained
 * on. "Thank you." and "Thanks for watching!" are the famous ones, and in a
 * kitchen they arrive constantly: an extractor fan or a pan lid trips the
 * voice detector, two hundred milliseconds of nothing goes off to be
 * transcribed, and the assistant answers a sentence the cook never said.
 *
 * Left unfiltered this compounds, because the assistant's reply is itself
 * sound: it trips the detector again, and the session fills with unprompted
 * turns that also talk over whoever is actually speaking.
 *
 * The list only matches a *whole* transcript. A cook who genuinely says "thank
 * you" and nothing else loses one reply; a cook who says "thank you, what's
 * next" keeps theirs, because that is not one of these.
 */

const ARTEFACTS = new Set([
  'thank you',
  'thanks',
  'thank you very much',
  'thank you so much',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'thank you for watching!',
  'thank you.',
  'you',
  'bye',
  'bye.',
  'goodbye',
  'okay',
  'ok',
  'oh',
  'mm',
  'hmm',
  'um',
  'uh',
  'the',
  'so',
  'silence',
  'music',
  'applause',
  'blank_audio',
  'inaudible',
  'subs by www.zeoranger.co.uk',
  'subtitles by the amara.org community',
]);

/** Bracketed and musical annotations: [BLANK_AUDIO], (silence), ♪♪♪. */
const ANNOTATION = /^[\s♪.·\-–—]*[[(][^\])]*[\])][\s♪.·\-–—]*$/;
const ONLY_PUNCTUATION = /^[\s.,!?;:'"♪·\-–—…]*$/;

export function normaliseTranscript(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[[\]()]/g, '')
    .replace(/[.!?,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a transcript is almost certainly the model filling in silence.
 *
 * Deliberately conservative about length: a long transcript is real speech
 * even if it happens to start with "thank you".
 */
/**
 * True when a transcript is mostly just the priming prompt read back.
 *
 * A domain hint improves recognition of ingredient names, but handed silence
 * Whisper does not only invent a pleasantry — it regurgitates the prompt it
 * was primed with. That is where "Ingredients, quantities, and quantities."
 * came from: it is this application's own hint, spoken back at it, and it is
 * far more convincing than "Thank you." because it is perfectly on topic.
 *
 * Only short transcripts are judged this way. Someone really can ask about
 * ingredients and quantities, but they will say more than the hint does.
 */
export function echoesPrompt(text: string, prompt: string): boolean {
  // Split on anything that is not a letter or digit: internal commas and full
  // stops otherwise leave "quantities," which never matches "quantities".
  const tokenise = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

  const words = tokenise(text);
  if (words.length === 0 || words.length > 12) return false;

  const promptWords = new Set(tokenise(prompt));
  const filler = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'to', 'for', 'is', 'are']);

  const content = words.filter((word) => !filler.has(word));
  if (content.length === 0) return true;

  const fromPrompt = content.filter((word) => promptWords.has(word)).length;
  return fromPrompt / content.length >= 0.8;
}

export function isLikelyHallucination(text: string, prompt?: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (ONLY_PUNCTUATION.test(raw)) return true;
  if (ANNOTATION.test(raw)) return true;
  if (prompt && echoesPrompt(raw, prompt)) return true;

  const normalised = normaliseTranscript(raw);
  if (!normalised) return true;
  if (ARTEFACTS.has(normalised)) return true;

  // "Thank you. Thank you. Thank you." — the same artefact, repeated, which is
  // what a longer stretch of silence produces.
  const words = normalised.split(' ');
  if (words.length <= 12) {
    const unique = new Set(words);
    if (unique.size === 1 && words.length > 1) return true;

    const withoutFiller = normalised.replace(/\b(thank you|thanks|you|bye|okay|ok)\b/g, '').trim();
    if (ONLY_PUNCTUATION.test(withoutFiller)) return true;
  }

  return false;
}
