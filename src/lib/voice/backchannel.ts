/**
 * Backchanneling (voice feature 1).
 *
 * A short "mm-hm" while the user is mid-sentence signals listening. The same
 * sound one beat too often signals a machine interrupting, which is worse than
 * silence — so the policy here is deliberately conservative, and it is a pure
 * function so the thresholds are testable rather than felt.
 *
 * Three conditions, all necessary:
 *   - the user has been speaking long enough that silence would feel dead
 *   - enough time has passed since the last acknowledgement
 *   - the assistant is not itself speaking (never talk over the user twice)
 */

export const BACKCHANNEL_PHRASES = ['Mm-hm.', 'Right.', 'Got it.', 'Okay.'] as const;

export const BACKCHANNEL_POLICY = {
  /** Continuous speech before the first acknowledgement is appropriate. */
  minSpeechMs: 3500,
  /** Minimum gap between acknowledgements within one user turn. */
  minGapMs: 9000,
  /** Hard cap per user turn. Two is companionable; three is chatter. */
  maxPerTurn: 2,
} as const;

export type BackchannelInput = {
  /** How long the user has been speaking continuously. */
  speechMs: number;
  /** Time since the last backchannel, or null if none yet this turn. */
  msSinceLast: number | null;
  /** How many have already played during this user turn. */
  countThisTurn: number;
  /** True while Rime audio is playing. */
  assistantSpeaking: boolean;
};

export function shouldBackchannel(input: BackchannelInput): boolean {
  if (input.assistantSpeaking) return false;
  if (input.countThisTurn >= BACKCHANNEL_POLICY.maxPerTurn) return false;
  if (input.speechMs < BACKCHANNEL_POLICY.minSpeechMs) return false;
  if (input.msSinceLast !== null && input.msSinceLast < BACKCHANNEL_POLICY.minGapMs) return false;
  return true;
}

/** Rotates rather than randomises: the same sound twice running reads as a bug. */
export function pickBackchannel(index: number): string {
  const phrase = BACKCHANNEL_PHRASES[index % BACKCHANNEL_PHRASES.length];
  return phrase ?? 'Mm-hm.';
}
