import { z } from 'zod';
import { listActiveTimers, startTimer } from '../db/timers';
import { defineTool, jsonSchema } from './types';

/** "eight minutes" → ms, spoken back as words so the cook can check it. */
function describeDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} seconds`;
  if (seconds === 0) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and ${seconds} seconds`;
}

export const startTimerTool = defineTool({
  name: 'start_timer',
  description:
    'Start a kitchen timer. Durations are given in seconds. Timers are attached to the current cooking session and survive a page reload.',
  schema: z.object({
    duration_seconds: z.number().int().min(1).max(86400),
    label: z.string().trim().max(60).default('timer'),
  }),
  parameters: jsonSchema(
    {
      duration_seconds: jsonSchema.integer('How long the timer runs, in seconds.'),
      label: jsonSchema.string('What the timer is for, such as "pasta".'),
    },
    ['duration_seconds'],
  ),
  filler: ['Setting that now.', 'One moment.'],
  async execute(args, ctx) {
    const requestedMs = args.duration_seconds * 1000;
    const running = await listActiveTimers(ctx.db, ctx.state.session.id);

    /*
     * Refuse a timer for work the cook has not started.
     *
     * Observed live: while the cook was still seasoning the chicken, the model
     * started an eight-minute "chicken cooking" timer for a later step. Two
     * minutes later they reached that step and it started its own clock, so
     * two timers were counting the same eight minutes from different moments.
     * The visible one was ahead of the pan, and a cook trusting it takes the
     * chicken out early — this is a wrong answer about food, not clutter.
     *
     * The prompt asks the model not to. It did anyway, which is what code is
     * for.
     */
    const upcoming = (ctx.state.recipe?.steps ?? []).findIndex(
      (step, index) =>
        index > ctx.state.snapshot.currentStep &&
        step.attention === 'passive' &&
        step.durationSeconds !== null &&
        Math.abs(step.durationSeconds * 1000 - requestedMs) <= requestedMs * 0.2,
    );

    if (upcoming !== -1) {
      return {
        data: {
          started: false,
          reason: 'not_started_yet',
          note: `That is step ${upcoming + 1}, which the user has not reached. Its timer starts by itself when they get there — do not set one now. Tell them what to do next instead.`,
        },
      };
    }

    // A second timer of the same length is a duplicate of one already running.
    const duplicate = running.find(
      (timer) => Math.abs(timer.durationMs - requestedMs) <= requestedMs * 0.2,
    );
    if (duplicate) {
      return {
        data: {
          started: false,
          reason: 'already_running',
          label: duplicate.label,
          remaining: describeDuration(duplicate.remainingMs),
          note: 'A timer for this is already counting down. Tell the user how long is left rather than starting another.',
        },
      };
    }

    const timer = await startTimer(ctx.db, {
      sessionId: ctx.state.session.id,
      durationMs: requestedMs,
      label: args.label,
    });
    return {
      stateChanged: true,
      data: {
        started: true,
        timer_id: timer.id,
        label: timer.label,
        duration: describeDuration(timer.durationMs),
      },
    };
  },
});

export const getTimerStatusTool = defineTool({
  name: 'get_timer_status',
  description: 'Check how long is left on the running timers for this cooking session.',
  schema: z.object({}),
  parameters: jsonSchema({}, []),
  filler: ['Let me check.', 'One moment.'],
  async execute(_args, ctx) {
    const timers = await listActiveTimers(ctx.db, ctx.state.session.id);
    return {
      data: {
        count: timers.length,
        timers: timers.map((timer) => ({
          timer_id: timer.id,
          label: timer.label,
          remaining: timer.expired ? 'finished' : describeDuration(timer.remainingMs),
          expired: timer.expired,
        })),
      },
    };
  },
});
