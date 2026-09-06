/**
 * "Writing for the ear" normaliser.
 *
 * Recipe text is written to be read: `200g`, `1/2 tsp`, `180°C`, `8 min`.
 * Handed to any TTS verbatim those come out as a smear the cook cannot act on,
 * and a misheard quantity is a ruined dish rather than a UX blemish.
 *
 * So assistant text passes through here before it reaches the provider. Units
 * become words, fractions become spoken fractions, and — for the precise
 * profile — a comma is inserted before the number, which `coda` renders as a
 * breath-length pause. That pause is the mechanism behind "Your timer is set
 * for… eight minutes."
 *
 * Each rule is separable and tested; `explain()` reports which fired.
 */

/**
 * Abbreviated units, with singular and plural forms.
 *
 * The leading character class includes the fraction glyphs so "½ tsp" keeps
 * its unit, and units are expanded *before* fractions are turned into words —
 * once "1/2" has become "half" there is no digit left for these to anchor on.
 */
const UNIT_WORDS: Array<[RegExp, string, string]> = [
  [/([0-9½¼¾⅓⅔])\s*kg\b/gi, 'kilogram', 'kilograms'],
  [/([0-9½¼¾⅓⅔])\s*g\b/gi, 'gram', 'grams'],
  [/([0-9½¼¾⅓⅔])\s*ml\b/gi, 'millilitre', 'millilitres'],
  [/([0-9½¼¾⅓⅔])\s*l\b/gi, 'litre', 'litres'],
  [/([0-9½¼¾⅓⅔])\s*tbsp\b/gi, 'tablespoon', 'tablespoons'],
  [/([0-9½¼¾⅓⅔])\s*tsp\b/gi, 'teaspoon', 'teaspoons'],
  [/([0-9½¼¾⅓⅔])\s*oz\b/gi, 'ounce', 'ounces'],
  [/([0-9½¼¾⅓⅔])\s*lbs?\b/gi, 'pound', 'pounds'],
  [/([0-9½¼¾⅓⅔])\s*min\b/gi, 'minute', 'minutes'],
  [/([0-9½¼¾⅓⅔])\s*sec\b/gi, 'second', 'seconds'],
  [/([0-9½¼¾⅓⅔])\s*hrs?\b/gi, 'hour', 'hours'],
  [/([0-9½¼¾⅓⅔])\s*°\s*C\b/gi, 'degree celsius', 'degrees celsius'],
  [/([0-9½¼¾⅓⅔])\s*°\s*F\b/gi, 'degree fahrenheit', 'degrees fahrenheit'],
];

function expandUnits(text: string): string {
  return UNIT_WORDS.reduce(
    (acc, [pattern, singular, plural]) =>
      // "1 tablespoon", not "1 tablespoons": the assistant is speaking, and a
      // plural after "one" is the kind of thing that makes a voice sound wrong
      // without the listener being able to say why.
      acc.replace(pattern, (_match, lead: string) => `${lead} ${lead === '1' ? singular : plural}`),
    text,
  );
}

const FRACTIONS: Array<[RegExp, string]> = [
  [/\b1\/2\b/g, 'half'],
  [/\b1\/3\b/g, 'a third'],
  [/\b2\/3\b/g, 'two thirds'],
  [/\b1\/4\b/g, 'a quarter'],
  [/\b3\/4\b/g, 'three quarters'],
  [/½/g, 'half'],
  [/¼/g, 'a quarter'],
  [/¾/g, 'three quarters'],
  [/⅓/g, 'a third'],
  [/⅔/g, 'two thirds'],
];

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (!Number.isInteger(n)) {
    const [whole, frac] = String(n).split('.');
    const digits = (frac ?? '').split('').map((d) => ONES[Number(d)] ?? d).join(' ');
    return `${numberToWords(Number(whole ?? 0))} point ${digits}`;
  }
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] ?? '';
    const ones = n % 10;
    return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
  }
  if (n < 1000) {
    const hundreds = ONES[Math.floor(n / 100)] ?? '';
    const rest = n % 100;
    return rest === 0 ? `${hundreds} hundred` : `${hundreds} hundred ${numberToWords(rest)}`;
  }
  if (n < 1_000_000) {
    const thousands = numberToWords(Math.floor(n / 1000));
    const rest = n % 1000;
    return rest === 0 ? `${thousands} thousand` : `${thousands} thousand ${numberToWords(rest)}`;
  }
  return String(n);
}

export type SpeakableOptions = {
  /** Expand digits into words and add pause commas before quantities. */
  precise?: boolean;
};

export type SpeakableResult = {
  text: string;
  rules: string[];
};

export function toSpeakableExplained(input: string, options: SpeakableOptions = {}): SpeakableResult {
  const rules: string[] = [];
  let text = input.trim();

  const apply = (rule: string, fn: (value: string) => string) => {
    const next = fn(text);
    if (next !== text) rules.push(rule);
    text = next;
  };

  // Markdown survives copy-paste from recipe sites and must never be spoken.
  apply('strip-markup', (t) =>
    t
      .replace(/[*_`#>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s{2,}/g, ' '),
  );

  apply('units', expandUnits);
  apply('fractions', (t) => FRACTIONS.reduce((acc, [re, word]) => acc.replace(re, word), t));

  // "8-10 minutes" reads as a subtraction unless the dash becomes a word.
  apply('ranges', (t) => t.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2'));

  if (options.precise) {
    apply('numbers-to-words', (t) =>
      t.replace(/\b\d+(\.\d+)?\b/g, (match) => numberToWords(Number(match))),
    );
    // A pause immediately before the quantity is what gives the cook time to
    // reach for the scale. Only inserted once, and never at the very start.
    apply('pause-before-quantity', (t) =>
      t.replace(
        /(\S)\s+(for|is|are|of|to)\s+((?:[a-z-]+\s+){0,2}(?:hundred|thousand|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))\b/i,
        '$1 $2,, $3',
      ),
    );
  }

  apply('collapse-space', (t) => t.replace(/\s+/g, ' ').trim());

  return { text, rules };
}

export function toSpeakable(input: string, options: SpeakableOptions = {}): string {
  return toSpeakableExplained(input, options).text;
}

/**
 * Split assistant text into clauses for streaming.
 *
 * The provider is handed complete clauses rather than a whole paragraph so the
 * first audio starts as early as possible, and so a barge-in lands on a clause
 * boundary the heard-transcript ledger can reason about.
 */
export function segmentForSpeech(text: string, maxChars = 220): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?]+[.!?]*/g) ?? [normalized];
  const out: string[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      out.push(trimmed);
      continue;
    }
    // Over-long sentence: break on commas, then hard-wrap whatever is left.
    let buffer = '';
    for (const part of trimmed.split(/,\s*/)) {
      const candidate = buffer ? `${buffer}, ${part}` : part;
      if (candidate.length > maxChars && buffer) {
        out.push(buffer);
        buffer = part;
      } else {
        buffer = candidate;
      }
    }
    if (buffer) out.push(buffer);
  }

  return out;
}
