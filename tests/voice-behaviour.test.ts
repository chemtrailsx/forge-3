import { afterEach, describe, expect, it } from 'vitest';
import { PROFILES, selectProfile } from '@/lib/tts/speech-profile';
import { segmentForSpeech, toSpeakable, toSpeakableExplained, numberToWords } from '@/lib/tts/speakable';
import { shouldBackchannel, pickBackchannel, BACKCHANNEL_POLICY } from '@/lib/voice/backchannel';
import { VoiceActivityDetector, DEFAULT_VAD } from '@/lib/audio/vad';
import { runTurn } from '@/lib/voice/orchestrator';
import type { TurnEvent } from '@/lib/voice/events';
import { ALICE, ALICE_SESSION, FakeLlm, FakeTts, makeDb, seedTables, toolCall } from './helpers/fixtures';

afterEach(() => {
  process.env.TOOL_DELAY_MS = '0';
});

async function collect(events: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('dynamic speaking speed', () => {
  it('slows down for measurements, timers and temperatures', () => {
    expect(selectProfile('You will need 600 g of spaghetti.').name).toBe('precise');
    expect(selectProfile('Your timer is set for 8 minutes.').name).toBe('precise');
    expect(selectProfile('Heat the oven to 180 degrees.').name).toBe('precise');
  });

  it('keeps short acknowledgements quick', () => {
    expect(selectProfile('Sure, let me check that.').name).toBe('quick');
    expect(selectProfile('Done.').name).toBe('quick');
  });

  it('uses the normal profile for explanation', () => {
    expect(selectProfile('Toss the pasta through the butter until it looks glossy.').name).toBe(
      'normal',
    );
  });

  it('prefers precision over brevity when a short line carries a number', () => {
    // Short *and* numeric: the number is the part that has to land.
    expect(selectProfile('Okay, 8 minutes.').name).toBe('precise');
  });

  it('maps each profile onto a real, in-range Rime rate', () => {
    expect(PROFILES.precise.timeScaleFactor).toBeGreaterThan(1);
    expect(PROFILES.quick.timeScaleFactor).toBeLessThan(1);
    expect(PROFILES.normal.timeScaleFactor).toBe(1);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.timeScaleFactor).toBeGreaterThanOrEqual(0.4);
      expect(profile.timeScaleFactor).toBeLessThanOrEqual(2.5);
    }
  });

  it('routes rate-changed speech to the transport that honours the rate', () => {
    // timeScaleFactor is an HTTP-only control; ws3 ignores it.
    expect(PROFILES.precise.transport).toBe('http');
    expect(PROFILES.quick.transport).toBe('http');
    expect(PROFILES.normal.transport).toBe('ws');
  });
});

describe('writing for the ear', () => {
  it('expands units so a quantity is not a smear of letters', () => {
    expect(toSpeakable('Add 200g of pasta and 1 tbsp of oil.')).toBe(
      'Add 200 grams of pasta and 1 tablespoon of oil.',
    );
  });

  it('speaks fractions as words without losing the unit', () => {
    expect(toSpeakable('Add 1/2 tsp of salt.')).toBe('Add half teaspoons of salt.');
    expect(toSpeakable('Add ½ tsp of salt.')).toBe('Add half teaspoons of salt.');
    expect(toSpeakable('Add ¾ cup of milk.')).toContain('three quarters');
  });

  it('reads a range as a range rather than a subtraction', () => {
    expect(toSpeakable('Simmer for 8-10 minutes.')).toContain('8 to 10 minutes');
  });

  it('turns numbers into words and adds a pause for precise delivery', () => {
    const result = toSpeakableExplained('Your timer is set for 8 minutes.', { precise: true });
    expect(result.text).toContain('eight minutes');
    expect(result.text).toContain(',,');
    expect(result.rules).toContain('numbers-to-words');
    expect(result.rules).toContain('pause-before-quantity');
  });

  it('never speaks markdown out loud', () => {
    expect(toSpeakable('**Drain** the _pasta_ now.')).toBe('Drain the pasta now.');
  });

  it('converts numbers the way a person says them', () => {
    expect(numberToWords(8)).toBe('eight');
    expect(numberToWords(45)).toBe('forty-five');
    expect(numberToWords(600)).toBe('six hundred');
    expect(numberToWords(1200)).toBe('one thousand two hundred');
  });

  it('splits long text into speakable clauses', () => {
    const segments = segmentForSpeech('Boil the water. Add the pasta. Cook for eight minutes.');
    expect(segments).toHaveLength(3);
    expect(segments[2]).toBe('Cook for eight minutes.');
  });

  it('breaks an over-long sentence on commas rather than mid-word', () => {
    const long = `Add ${'the very finely sliced garlic, '.repeat(12)}and stir.`;
    for (const segment of segmentForSpeech(long, 120)) {
      expect(segment.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('backchanneling', () => {
  it('stays silent early in a turn', () => {
    expect(
      shouldBackchannel({
        speechMs: 1000,
        msSinceLast: null,
        countThisTurn: 0,
        assistantSpeaking: false,
      }),
    ).toBe(false);
  });

  it('acknowledges a long user turn', () => {
    expect(
      shouldBackchannel({
        speechMs: BACKCHANNEL_POLICY.minSpeechMs + 100,
        msSinceLast: null,
        countThisTurn: 0,
        assistantSpeaking: false,
      }),
    ).toBe(true);
  });

  it('never talks over its own speech', () => {
    expect(
      shouldBackchannel({
        speechMs: 10000,
        msSinceLast: null,
        countThisTurn: 0,
        assistantSpeaking: true,
      }),
    ).toBe(false);
  });

  it('enforces a gap and a per-turn cap so it does not become chatter', () => {
    expect(
      shouldBackchannel({ speechMs: 9000, msSinceLast: 2000, countThisTurn: 1, assistantSpeaking: false }),
    ).toBe(false);
    expect(
      shouldBackchannel({
        speechMs: 30000,
        msSinceLast: 20000,
        countThisTurn: BACKCHANNEL_POLICY.maxPerTurn,
        assistantSpeaking: false,
      }),
    ).toBe(false);
  });

  it('rotates phrases instead of repeating one', () => {
    expect(pickBackchannel(0)).not.toBe(pickBackchannel(1));
  });
});

describe('voice activity detection', () => {
  const feed = (vad: VoiceActivityDetector, rms: number, ms: number) => {
    const events: Array<string | null> = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 20) events.push(vad.push(rms, 20));
    return events;
  };

  it('ignores steady kitchen noise', () => {
    const vad = new VoiceActivityDetector();
    const events = feed(vad, 0.004, 3000);
    expect(events.filter(Boolean)).toEqual([]);
    expect(vad.isSpeaking).toBe(false);
  });

  it('fires on speech after the onset window, not on a single transient', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.003, 1000);

    expect(vad.push(0.2, 20)).toBeNull(); // one loud window is not a turn
    const events = feed(vad, 0.2, DEFAULT_VAD.onsetMs + 40);
    expect(events).toContain('speech-start');
    expect(vad.isSpeaking).toBe(true);
  });

  it('ends the turn only after the hangover, so a mid-sentence pause survives', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.003, 500);
    feed(vad, 0.2, 400);

    expect(feed(vad, 0.002, 300).filter(Boolean)).toEqual([]);
    expect(vad.isSpeaking).toBe(true);

    expect(feed(vad, 0.002, DEFAULT_VAD.hangoverMs + 100)).toContain('speech-end');
    expect(vad.isSpeaking).toBe(false);
  });

  it('adapts its floor to a noisier room without going deaf to speech', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, 0.009, 4000);
    expect(vad.floor).toBeGreaterThan(0.005);
    expect(feed(vad, 0.25, 400)).toContain('speech-start');
  });
});

describe('voice fillers during tool calls', () => {
  it('speaks a filler while a slow tool runs, before the result exists', async () => {
    process.env.TOOL_DELAY_MS = '500';
    const { db } = makeDb(ALICE, seedTables());
    const tts = new FakeTts();

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'scale it to six people',
        signal: new AbortController().signal,
        llm: new FakeLlm(
          [{ content: '', toolCalls: [toolCall('scale_recipe', { servings: 6 })] }],
          'You will need 600 g of spaghetti.',
        ),
        tts,
      }),
    );

    const types = events.map((event) => event.type);
    const fillerIndex = types.indexOf('filler');
    const toolEndIndex = types.indexOf('tool.end');

    expect(fillerIndex).toBeGreaterThan(-1);
    // The whole point: the filler reaches the user before the tool returns.
    expect(fillerIndex).toBeLessThan(toolEndIndex);

    // And it was actually spoken, not merely announced.
    const fillerEvent = events[fillerIndex];
    expect(fillerEvent?.type === 'filler' ? fillerEvent.text : '').toBeTruthy();
    expect(tts.spoken[0]?.profile.name).toBe('quick');
  });

  it('does not speak a filler when the tool returns immediately', async () => {
    process.env.TOOL_DELAY_MS = '0';
    const { db } = makeDb(ALICE, seedTables());

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what have I got saved?',
        signal: new AbortController().signal,
        llm: new FakeLlm(
          [{ content: '', toolCalls: [toolCall('search_user_recipes', { query: 'pasta' })] }],
          'You have one pasta recipe saved.',
        ),
        tts: new FakeTts(),
      }),
    );

    // A filler for a call that returns in a few milliseconds *is* the delay.
    expect(events.some((event) => event.type === 'filler')).toBe(false);
  });

  it('never leaves a filler followed by silence when the model returns nothing', async () => {
    process.env.TOOL_DELAY_MS = '0';
    const { db } = makeDb(ALICE, seedTables());
    const tts = new FakeTts();

    // Empty stream, and an empty retry after it — the worst case.
    const llm = new FakeLlm(
      [
        { content: '', toolCalls: [toolCall('search_user_recipes', { query: 'pasta' })] },
        { content: '' },
      ],
      '',
    );

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what have I got saved?',
        signal: new AbortController().signal,
        llm,
        tts,
      }),
    );

    // It retried the completion rather than giving up on the first empty reply.
    expect(llm.completeCalls.length).toBe(2);

    const end = events.find((event) => event.type === 'turn.end');
    const text = end?.type === 'turn.end' ? end.text : '';
    expect(text).toMatch(/sorry/i);
    // Something was actually spoken, so the turn does not end in dead air.
    expect(tts.spoken.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'audio')).toBe(true);
  });

  it('uses a retried answer when the stream came back empty', async () => {
    process.env.TOOL_DELAY_MS = '0';
    const { db } = makeDb(ALICE, seedTables());

    const llm = new FakeLlm(
      [
        { content: '', toolCalls: [toolCall('search_user_recipes', { query: 'pasta' })] },
        { content: 'You have one pasta recipe saved.' },
      ],
      '',
    );

    const events = await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'what have I got saved?',
        signal: new AbortController().signal,
        llm,
        tts: new FakeTts(),
      }),
    );

    const end = events.find((event) => event.type === 'turn.end');
    expect(end?.type === 'turn.end' ? end.text : '').toBe('You have one pasta recipe saved.');
  });

  it('speaks the real answer with the precise profile once the tool returns', async () => {
    process.env.TOOL_DELAY_MS = '0';
    const { db } = makeDb(ALICE, seedTables());
    const tts = new FakeTts();

    await collect(
      runTurn({
        db,
        sessionId: ALICE_SESSION,
        utterance: 'scale it to six people',
        signal: new AbortController().signal,
        llm: new FakeLlm(
          [{ content: '', toolCalls: [toolCall('scale_recipe', { servings: 6 })] }],
          'You will need 600 g of spaghetti.',
        ),
        tts,
      }),
    );

    const answer = tts.spoken.at(-1);
    expect(answer?.profile.name).toBe('precise');
    expect(answer?.text).toContain('six hundred grams');
  });
});
