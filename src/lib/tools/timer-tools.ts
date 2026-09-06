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
    const timer = await startTimer(
      ctx.db,
      ctx.state.session.id,
      args.duration_seconds * 1000,
      args.label,
    );
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
