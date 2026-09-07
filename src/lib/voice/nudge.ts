import type { CookingStateSnapshot, TimerView } from '../types';
import type { SpeechProfileName } from '../tts/types';

/**
 * When the assistant may speak without being spoken to.
 *
 * This is the only place in the product where the machine takes the turn, so
 * it is the place most able to make it unbearable. A cook who gets interrupted
 * while talking, or told the same thing twice, or reminded about a pan they are
 * already standing over, will turn it off — and then the one reminder that
 * mattered never arrives either.
 *
 * So the policy is conservative and it is a pure function: the thresholds are
 * asserted in tests rather than felt in a demo.
 *
 * Two things earn an interruption:
 *   - something finished that nobody is watching
 *   - something is close to finishing and the cook is deep in another step
 *
 * Nothing else does. "You have been on this step a while" is not a reminder,
 * it is nagging.
 */

export const NUDGE_POLICY = {
  /** Never two reminders closer together than this. */
  minGapMs: 25_000,
  /** How near the end counts as "almost done" for a heads-up. */
  headsUpWindowMs: 60_000,
  /** A heads-up is only worth it if the step ran long enough to forget about. */
  headsUpMinDurationMs: 240_000,
} as const;

export type NudgeInput = {
  state: CookingStateSnapshot;
  /** Running timers, including expired ones not yet announced. */
  timers: TimerView[];
  assistantSpeaking: boolean;
  userSpeaking: boolean;
  /** Milliseconds since the assistant last said anything unprompted. */
  msSinceLastNudge: number | null;
  now?: number;
};

export type Nudge = {
  /** The timer this is about, so the caller can mark it announced. */
  timerId: string;
  text: string;
  profile: SpeechProfileName;
  reason: 'finished' | 'almost';
};

export function selectNudge(input: NudgeInput): Nudge | null {
  // Never talk over the cook, and never talk over ourselves. Both would make
  // the interruption the problem rather than the thing it is about.
  if (input.userSpeaking || input.assistantSpeaking) return null;
  if (input.msSinceLastNudge !== null && input.msSinceLastNudge < NUDGE_POLICY.minGapMs) {
    return null;
  }

  const now = input.now ?? Date.now();

  // Something finished. Oldest first: if two things landed together, the one
  // that has been sitting longest is the one at risk.
  const finished = input.timers
    .filter((timer) => timer.remindedAt === null && remainingMs(timer, now) <= 0)
    .sort((a, b) => endsAt(a) - endsAt(b));

  const done = finished[0];
  if (done) {
    return {
      timerId: done.id,
      // Timers and steps are announced differently because they mean different
      // things: one is a bell the cook set, the other is the assistant
      // reporting on work it was watching.
      text:
        done.kind === 'step'
          ? `Your ${bareLabel(done.label)} should be ready now.`
          : `That's your ${bareLabel(done.label)} timer.`,
      // Precise: this is the sentence that has to land over a running tap.
      profile: 'precise',
      reason: 'finished',
    };
  }

  // Nothing finished. A heads-up is only justified when the cook has had long
  // enough to lose track, and only for work the assistant started — a timer
  // the cook set themselves is theirs to expect.
  const soon = input.timers
    .filter(
      (timer) =>
        timer.headsUpAt === null &&
        timer.kind === 'step' &&
        timer.durationMs >= NUDGE_POLICY.headsUpMinDurationMs &&
        remainingMs(timer, now) > 0 &&
        remainingMs(timer, now) <= NUDGE_POLICY.headsUpWindowMs,
    )
    .sort((a, b) => remainingMs(a, now) - remainingMs(b, now));

  const nearlyDone = soon[0];
  if (nearlyDone) {
    const minutes = Math.max(1, Math.round(remainingMs(nearlyDone, now) / 60_000));
    return {
      timerId: nearlyDone.id,
      text: `Heads up — your ${bareLabel(nearlyDone.label)} has about ${minutes === 1 ? 'a minute' : `${minutes} minutes`} left.`,
      profile: 'precise',
      reason: 'almost',
    };
  }

  return null;
}

/**
 * A label that reads correctly after "your".
 *
 * Labels arrive from two places — a step description and whatever the cook
 * called their own timer — and only one of them is under our control. "Your
 * the spaghetti should be ready" is the kind of sentence that makes a voice
 * sound broken even when the timing is perfect.
 */
function bareLabel(label: string): string {
  return label.trim().replace(/^(the|a|an|some|your|my)\s+/i, '') || 'that';
}

function endsAt(timer: TimerView): number {
  return new Date(timer.startedAt).getTime() + timer.durationMs;
}

function remainingMs(timer: TimerView, now: number): number {
  return endsAt(timer) - now;
}
