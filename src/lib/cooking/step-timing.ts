import { readSpokenNumber } from './spoken-numbers';

/**
 * Works out how long a step runs and whether it needs the cook's hands, from
 * the instruction itself.
 *
 * The model is asked to mark this, and it is unreliable at it in the way that
 * matters most: given "add the spaghetti and cook until al dente, about nine
 * minutes" it marked the step *active* with no duration, while marking "heat
 * the oil in a skillet" passive. It understands the parallelism — the next
 * step it wrote began "while the pasta cooks" — but cannot consistently put
 * that understanding in a field.
 *
 * So the text decides. A step that names a waiting verb and a duration is one
 * the cook can walk away from, whatever the model labelled it.
 *
 * The bias is deliberate. Wrongly calling a step passive costs a reminder
 * nobody needed; wrongly calling it active means the pasta boils over while
 * the assistant says nothing, which is the entire feature failing silently.
 */

/**
 * Verbs that keep the cook at the pan even though a duration is mentioned.
 * "Stirring constantly for three minutes" is three minutes of work, not three
 * minutes of freedom.
 */
const HANDS_ON =
  /\b(stir(ring)?\s+(constantly|continuously|often)|whisk(ing)?\s+(constantly|continuously)|knead(ing)?|chop(ping)?|dice|dicing|slice|slicing|mince|mincing|grate|grating)\b/i;

const UNIT_SECONDS: Record<string, number> = {
  second: 1, seconds: 1, sec: 1, secs: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
};

export type StepTiming = {
  durationSeconds: number | null;
  attention: 'active' | 'passive';
};

/**
 * Finds the first duration in a step.
 *
 * A range takes its lower bound: "eight to ten minutes" reminds at eight, so
 * the cook checks a pan that might be ready rather than one that is already
 * past it.
 */
export function extractDurationSeconds(text: string): number | null {
  const tokens = text.toLowerCase().replace(/[(),.]/g, ' ').split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    const unit = UNIT_SECONDS[token];
    if (unit === undefined) continue;

    // Walk back over the words between the number and its unit — "about",
    // "to", a range's upper bound — to find where the quantity starts.
    //
    // Keep going past the first hit rather than stopping at it: in "eight to
    // ten minutes" the nearest number is the *upper* bound, and taking it
    // would remind the cook two minutes after the pasta was ready. The
    // furthest number still bridged to the unit is the lower bound.
    let lowest: number | null = null;

    for (let back = 1; back <= 5 && i - back >= 0; back += 1) {
      const start = i - back;
      const candidate = tokens[start];
      if (candidate === undefined) continue;

      // "25-30" arrives as one token, and is a range like any other: the lower
      // bound is what the cook should be called back for.
      const hyphenated = /^(\d+(?:\.\d+)?)\s*[-–—]\s*\d+(?:\.\d+)?$/.exec(candidate);
      const digits = hyphenated
        ? Number(hyphenated[1])
        : /^\d+(?:\.\d+)?$/.test(candidate)
          ? Number(candidate)
          : null;
      const spoken = digits === null ? readSpokenNumber(tokens, start) : null;
      const value = digits ?? spoken?.value ?? null;
      if (value === null) continue;

      // Only accept if everything between the number and the unit is filler —
      // including the range's other bound, which may itself be a word
      // ("eight to ten minutes").
      const between = tokens.slice(spoken ? spoken.next : start + 1, i);
      const bridged = between.every(
        (word) =>
          /^(to|or|and|about|around|roughly|approximately|another|more|-|–|—|\d+(\.\d+)?)$/.test(
            word,
          ) || readSpokenNumber([word], 0) !== null,
      );
      if (!bridged) continue;

      lowest = value;
    }

    if (lowest !== null) return Math.round(lowest * unit);
  }

  return null;
}

export function inferStepTiming(text: string, stated?: Partial<StepTiming>): StepTiming {
  // The text outranks the field. Where the two disagree the text is what the
  // cook was actually told — and it is the field that has been observed to be
  // wrong, including a duration attached to the wrong step entirely.
  const duration = extractDurationSeconds(text) ?? stated?.durationSeconds ?? null;

  // Nothing to wait for: whatever it is, the cook is doing it.
  if (!duration || duration <= 0) {
    return { durationSeconds: null, attention: stated?.attention ?? 'active' };
  }

  // A duration spent working is not a duration spent free.
  if (HANDS_ON.test(text)) {
    return { durationSeconds: duration, attention: 'active' };
  }

  // Anything under a minute is not worth leaving the kitchen for, and a
  // reminder that soon is noise rather than help.
  if (duration < 60) {
    return { durationSeconds: duration, attention: stated?.attention ?? 'active' };
  }

  // A minute or more of stated time, with nothing to do during it, is time the
  // cook can spend elsewhere. Listing the verbs that qualify was tried first
  // and is the wrong shape: the list is unbounded, and every verb missing from
  // it is a pan that finishes in silence.
  return { durationSeconds: duration, attention: 'passive' };
}
