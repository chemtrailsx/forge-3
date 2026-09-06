import type { SpeechProfile, SpeechProfileName } from './types';

/**
 * Dynamic speaking speed (voice feature 4).
 *
 * Two mechanisms, because Rime exposes speed on one transport only:
 *
 *  1. `timeScaleFactor` — a real rate change, documented for `coda` on the
 *     HTTP endpoint and *ignored* over the ws3 WebSocket. So a profile that
 *     needs a rate change also selects the HTTP transport.
 *  2. Prosody shaping in `speakable.ts` — commas and ellipses that `coda`
 *     renders as breath-length pauses, plus digits expanded into words. This
 *     works on every transport and is what makes "eight minutes" land as
 *     something a cook can act on.
 *
 * The precise profile is the one that matters: a misheard quantity or timer is
 * a ruined dish, and the cook has no screen to check it against.
 */

export const PROFILES: Record<SpeechProfileName, SpeechProfile> = {
  // Long-form explanation and recipe steps. Streams over the WebSocket so the
  // first syllable starts before the sentence is finished being generated.
  normal: { name: 'normal', timeScaleFactor: 1.0, transport: 'ws' },
  // Short status and acknowledgements — fillers, backchannels, "got it".
  // Slightly quicker, and short enough that a single HTTP round trip is
  // cheaper than the ceremony of a streamed context.
  quick: { name: 'quick', timeScaleFactor: 0.92, transport: 'http' },
  // Numbers, measurements, timers. Slower and clearer.
  precise: { name: 'precise', timeScaleFactor: 1.22, transport: 'http' },
};

/** Anything a cook has to hold in their head or act on exactly. */
const PRECISE_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?\s?(g|kg|ml|l|oz|lb|lbs|tsp|tbsp|cup|cups|teaspoons?|tablespoons?|grams?|millilitres?|litres?|ounces?|pounds?)\b/i,
  /\b\d+\s?(°|degrees?)\b/i,
  /\b\d+\s?(second|seconds|minute|minutes|hour|hours)\b/i,
  /\btimer\b/i,
  /\b(set|setting|remaining|left)\b.*\b\d+\b/i,
];

const QUICK_PATTERNS: RegExp[] = [
  /^(sure|okay|ok|right|got it|of course|no problem|mm-hm|one moment|let me)\b/i,
  /^(done|started|stopped|cancelled|saved)\b/i,
];

/**
 * Choose how a piece of assistant text should be spoken.
 *
 * Precise wins over quick: "Timer set for eight minutes" is short *and*
 * carries a number, and the number is the part that must land.
 */
export function selectProfile(text: string, hint?: SpeechProfileName): SpeechProfile {
  if (hint) return PROFILES[hint];

  const trimmed = text.trim();
  if (!trimmed) return PROFILES.normal;

  if (PRECISE_PATTERNS.some((re) => re.test(trimmed))) return PROFILES.precise;
  if (trimmed.length <= 60 && QUICK_PATTERNS.some((re) => re.test(trimmed))) return PROFILES.quick;
  return PROFILES.normal;
}
