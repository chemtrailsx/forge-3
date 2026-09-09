/**
 * Recognition vocabulary for the transcriber.
 *
 * Whisper accepts a prompt that biases decoding towards the words in it. Left
 * without one it falls back on what English audio usually contains, and a
 * kitchen is full of words that are not it: "lamb korma and tandoori naan"
 * came back as "a naan korma ... with a durin naan", and "what should I cook"
 * as "what I should call". Every one of those is a word the model had no
 * reason to expect and a near-homophone it did.
 *
 * Two sources, in this order of value:
 *
 *   what was just said — the assistant has usually named the dishes a moment
 *   before the cook says one back, and those exact words are the strongest
 *   possible hint;
 *
 *   a standing list — for the first utterance of a session, when there is no
 *   conversation to draw on yet.
 *
 * The prompt is capped because the model's own window for it is (224 tokens);
 * past that the beginning is dropped, which would silently discard the live
 * words in favour of the standing list.
 */

/**
 * Framing sentence, kept separate from the vocabulary on purpose.
 *
 * Handed silence, Whisper reads its prompt back. Only this part is passed to
 * the artefact filter: a transcript made of *vocabulary* words is what a cook
 * naming a dish sounds like, and discarding it as an echo would throw away the
 * very utterances this exists to catch.
 */
export const RECOGNITION_FRAMING = 'A cook is talking about the dish they are making.';

/**
 * Words a kitchen produces that general-purpose speech models mangle.
 *
 * Not a cuisine list and not exhaustive — no list could be. These are terms
 * with no common English near-neighbour, which is exactly when the model
 * substitutes something plausible and wrong.
 */
const STANDING_VOCABULARY = [
  // Dishes and breads that arrived as something else in real sessions.
  'korma',
  'tandoori',
  'naan',
  'roti',
  'paratha',
  'biryani',
  'pulao',
  'tikka',
  'masala',
  'paneer',
  'dal',
  'rajma',
  'chana',
  'sambar',
  'rasam',
  'dosa',
  'idli',
  'upma',
  'poha',
  'khichdi',
  'raita',
  'chutney',
  'kofta',
  'saag',
  'bhaji',
  'pakora',
  'samosa',
  'halwa',
  'kheer',
  // Aromatics and pantry terms.
  'jeera',
  'haldi',
  'garam',
  'methi',
  'ajwain',
  'hing',
  'ghee',
  'atta',
  'maida',
  'besan',
  'dahi',
  'malai',
  'coriander',
  'cumin',
  'turmeric',
  'cardamom',
  'fenugreek',
  'asafoetida',
  'tamarind',
  'jaggery',
  // The units and quantities the rest of the sentence is made of.
  'grams',
  'millilitres',
  'teaspoon',
  'tablespoon',
  'simmer',
  'saute',
  'temper',
  'marinate',
];

/** Whisper drops the front of an over-long prompt; stay well inside it. */
const MAX_PROMPT_CHARS = 700;

/** Words that carry no recognition value and would crowd out ones that do. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'is', 'are',
  'it', 'its', 'that', 'this', 'these', 'those', 'you', 'your', 'i', 'we', 'they', 'them', 'my',
  'have', 'has', 'had', 'do', 'does', 'did', 'be', 'been', 'will', 'would', 'can', 'could',
  'should', 'now', 'then', 'next', 'first', 'last', 'about', 'into', 'over', 'under', 'up',
  'down', 'out', 'off', 'if', 'so', 'but', 'as', 'at', 'by', 'from', 'not', 'no', 'yes', 'ok',
  'okay', 'right', 'well', 'just', 'let', 'lets', 'want', 'like', 'make', 'making', 'take',
  'give', 'get', 'got', 'put', 'add', 'more', 'some', 'any', 'all', 'one', 'two', 'three',
  'minutes', 'minute', 'seconds', 'until', 'while', 'when', 'what', 'how', 'why', 'where',
]);

/**
 * Distinctive words from a piece of conversation, most useful first.
 *
 * Order is preserved rather than sorted: a dish named at the end of the
 * assistant's turn is the one the cook is most likely about to repeat.
 */
export function distinctiveWords(text: string, limit = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z']+/)) {
    const word = raw.replace(/^'+|'+$/g, '');
    if (word.length < 3) continue;
    if (STOP_WORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

export type RecognitionContext = {
  /** What the assistant said last — the likeliest source of the next words. */
  spoken?: string;
  /** Ingredient names for the dish in progress. */
  ingredients?: string[];
  /** The dish itself. */
  dishTitle?: string;
};

/**
 * The prompt handed to the transcriber, framing first.
 *
 * Live words come before the standing list so that if anything is dropped it
 * is the generic half.
 */
export function buildRecognitionPrompt(context: RecognitionContext = {}): string {
  const live = [
    ...distinctiveWords(context.dishTitle ?? '', 8),
    ...distinctiveWords((context.ingredients ?? []).join(' '), 24),
    ...distinctiveWords(context.spoken ?? '', 32),
  ];

  const words: string[] = [];
  const seen = new Set<string>();
  for (const word of [...live, ...STANDING_VOCABULARY]) {
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }

  let prompt = RECOGNITION_FRAMING;
  for (const word of words) {
    const next = `${prompt} ${word},`;
    if (next.length > MAX_PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt.replace(/,$/, '.');
}
