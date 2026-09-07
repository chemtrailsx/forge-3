import { describe, expect, it } from 'vitest';
import { NUDGE_POLICY, selectNudge, type NudgeInput } from '@/lib/voice/nudge';
import { buildSnapshot } from '@/lib/cooking/state';
import { toView } from '@/lib/db/timers';
import type { CookingSession, TimerRecord, TimerView } from '@/lib/types';
import { ALICE } from './helpers/fixtures';

/**
 * The nudge is the only moment the assistant takes a turn nobody offered it.
 * Everything here is about not squandering that: a cook who gets talked over,
 * or told the same thing twice, turns the feature off — and then the reminder
 * that mattered never arrives either.
 */

const NOW = Date.parse('2026-09-07T18:00:00.000Z');

function timer(overrides: Partial<TimerRecord> & { startedAt?: string } = {}): TimerView {
  const record: TimerRecord = {
    id: 't1',
    label: 'the spaghetti',
    durationMs: 480_000,
    startedAt: new Date(NOW).toISOString(),
    status: 'running',
    kind: 'step',
    stepIndex: 1,
    headsUpAt: null,
    remindedAt: null,
    ...overrides,
  };
  return toView(record, NOW);
}

/** A timer that finished `agoMs` ago. */
function finished(agoMs: number, overrides: Partial<TimerRecord> = {}): TimerView {
  const duration = overrides.durationMs ?? 480_000;
  return timer({
    ...overrides,
    durationMs: duration,
    startedAt: new Date(NOW - duration - agoMs).toISOString(),
  });
}

const SESSION: CookingSession = {
  id: 's1',
  userId: ALICE,
  recipeId: 'r1',
  currentStep: 1,
  status: 'active',
  notes: {},
  createdAt: '',
  updatedAt: '',
};

function input(overrides: Partial<NudgeInput> = {}): NudgeInput {
  return {
    state: buildSnapshot(SESSION, null, []),
    timers: [],
    assistantSpeaking: false,
    userSpeaking: false,
    msSinceLastNudge: null,
    now: NOW,
    ...overrides,
  };
}

describe('when it stays quiet', () => {
  it('says nothing when nothing is cooking', () => {
    expect(selectNudge(input())).toBeNull();
  });

  it('says nothing while a timer is still running', () => {
    expect(selectNudge(input({ timers: [timer()] }))).toBeNull();
  });

  it('never interrupts the cook mid-sentence', () => {
    const finishedPasta = [finished(1000)];
    expect(selectNudge(input({ timers: finishedPasta, userSpeaking: true }))).toBeNull();
    // ...and the same reminder is still waiting once they stop.
    expect(selectNudge(input({ timers: finishedPasta }))).not.toBeNull();
  });

  it('never talks over its own voice', () => {
    expect(selectNudge(input({ timers: [finished(1000)], assistantSpeaking: true }))).toBeNull();
  });

  it('respects the gap between reminders', () => {
    const timers = [finished(1000)];
    expect(
      selectNudge(input({ timers, msSinceLastNudge: NUDGE_POLICY.minGapMs - 1000 })),
    ).toBeNull();
    expect(
      selectNudge(input({ timers, msSinceLastNudge: NUDGE_POLICY.minGapMs + 1000 })),
    ).not.toBeNull();
  });

  it('says nothing about something it has already announced', () => {
    const already = finished(60_000, { remindedAt: new Date(NOW - 50_000).toISOString() });
    expect(selectNudge(input({ timers: [already] }))).toBeNull();
  });
});

describe('when something finishes', () => {
  it('announces work it was watching in the cook\'s own terms', () => {
    const nudge = selectNudge(input({ timers: [finished(1000)] }));
    expect(nudge?.reason).toBe('finished');
    // Not "Your the spaghetti": the label carries an article and the sentence
    // supplies its own.
    expect(nudge?.text).toBe('Your spaghetti should be ready now.');
  });

  it('announces a timer the cook set as a timer', () => {
    const nudge = selectNudge(
      input({ timers: [finished(1000, { kind: 'timer', label: 'pasta' })] }),
    );
    expect(nudge?.text).toContain('pasta timer');
  });

  it('speaks it slowly, because it has to land over a running tap', () => {
    expect(selectNudge(input({ timers: [finished(1000)] }))?.profile).toBe('precise');
  });

  it('takes the one that has been waiting longest when two land together', () => {
    const nudge = selectNudge(
      input({
        timers: [
          finished(1000, { id: 'recent', label: 'the garlic' }),
          finished(120_000, { id: 'stale', label: 'the pasta' }),
        ],
      }),
    );
    // The pasta has been sitting in hot water for two minutes; the garlic can
    // wait five more seconds for the next poll.
    expect(nudge?.timerId).toBe('stale');
  });

  it('names the timer so the caller can mark that one announced', () => {
    const nudge = selectNudge(input({ timers: [finished(1000, { id: 'abc' })] }));
    expect(nudge?.timerId).toBe('abc');
  });
});

describe('the heads-up before something finishes', () => {
  it('warns on a long unattended step that is nearly done', () => {
    const roast = timer({
      durationMs: 45 * 60_000,
      label: 'the chicken',
      startedAt: new Date(NOW - 45 * 60_000 + 45_000).toISOString(),
    });
    const nudge = selectNudge(input({ timers: [roast] }));

    expect(nudge?.reason).toBe('almost');
    expect(nudge?.text).toContain('a minute left');
  });

  it('does not warn about a short step, which needs no warning', () => {
    const quick = timer({
      durationMs: 90_000,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(selectNudge(input({ timers: [quick] }))).toBeNull();
  });

  it('does not warn about a timer the cook set themselves', () => {
    // They set it; they are expecting it. A warning would be the assistant
    // narrating their own alarm clock back at them.
    const own = timer({
      kind: 'timer',
      durationMs: 45 * 60_000,
      startedAt: new Date(NOW - 45 * 60_000 + 30_000).toISOString(),
    });
    expect(selectNudge(input({ timers: [own] }))).toBeNull();
  });

  it('warns once, and still announces the finish afterwards', () => {
    const duration = 45 * 60_000;
    const warned = timer({
      durationMs: duration,
      headsUpAt: new Date(NOW - 30_000).toISOString(),
      startedAt: new Date(NOW - duration + 20_000).toISOString(),
    });
    // Already warned: nothing more to say yet.
    expect(selectNudge(input({ timers: [warned] }))).toBeNull();

    // The heads-up must not have consumed the finish. This is the bug the two
    // separate columns exist to prevent.
    const done = toView(
      {
        ...warned,
        startedAt: new Date(NOW - duration - 1000).toISOString(),
      },
      NOW,
    );
    const nudge = selectNudge(input({ timers: [done] }));
    expect(nudge?.reason).toBe('finished');
  });

  it('prefers announcing something finished over warning about something else', () => {
    const nearlyDone = timer({
      id: 'roast',
      durationMs: 45 * 60_000,
      startedAt: new Date(NOW - 45 * 60_000 + 30_000).toISOString(),
    });
    const nudge = selectNudge(input({ timers: [nearlyDone, finished(1000, { id: 'pasta' })] }));
    expect(nudge?.timerId).toBe('pasta');
  });
});
