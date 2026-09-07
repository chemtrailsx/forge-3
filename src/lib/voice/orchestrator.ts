import { randomUUID } from 'node:crypto';
import { loadCookingState, recordCorrection, type LoadedState } from '../cooking/state';
import type { Db } from '../db/context';
import { listMemory } from '../db/memory';
import { getProfile, type Preferences } from '../db/profiles';
import { markInterrupted, nextTurnIndex, recentTurns, recordTurn } from '../db/turns';
import { AppError, isAbort } from '../errors';
import { buildMessages } from '../llm/prompt';
import { getLlmProvider } from '../llm/provider';
import type { ChatMessage, LlmProvider, ToolCall } from '../llm/types';
import { selectRelevantMemory } from '../memory/retrieval';
import { getTtsProvider } from '../tts';
import { segmentForSpeech, toSpeakable } from '../tts/speakable';
import { selectProfile } from '../tts/speech-profile';
import type { SpeechProfileName, TtsProvider } from '../tts/types';
import { executeTool, fillerFor, toolSchemas } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import type { TurnEvent, TurnMetrics } from './events';

/**
 * One conversational turn, start to finish.
 *
 * Written as an async generator so the transport is not baked in: the route
 * handler serialises these events as SSE, and the tests consume the same
 * generator directly with fake providers. Everything that makes the voice loop
 * interesting — fillers, speech profiles, cancellation, the heard ledger —
 * is therefore testable without a network.
 *
 * Cancellation is the design constraint throughout. `signal` is threaded into
 * the model call, the tool call and the TTS stream, so a barge-in stops all
 * three rather than leaving one to finish and speak over the correction.
 */

export type InterruptionReport = {
  /** The assistant turn that was cut off. */
  turnIndex: number;
  /** What the user actually heard, from the client-side ledger. */
  heardText: string;
  /** Browser-measured time from speech onset to silence. */
  latencyMs: number;
};

export type RunTurnInput = {
  db: Db;
  sessionId: string;
  utterance: string;
  interruption?: InterruptionReport | null;
  signal: AbortSignal;
  /** Injected in tests; defaults to the configured providers. */
  llm?: LlmProvider;
  tts?: TtsProvider;
};

/**
 * A tool call must be covered by speech before the user notices the gap, but a
 * filler for a call that returns in 40 ms is itself the delay. 250 ms is about
 * where a pause starts to read as dead air.
 */
const FILLER_THRESHOLD_MS = 250;

/**
 * Spoken when the model returns nothing at all after a tool ran. It admits the
 * failure instead of inventing a result — the tool may well have succeeded,
 * but this turn has no answer to report, and guessing one is worse than saying
 * so to someone who cannot see a screen.
 */
const EMPTY_ANSWER_FALLBACK = 'Sorry, I lost that one. Could you ask me again?';

export async function* runTurn(input: RunTurnInput): AsyncGenerator<TurnEvent> {
  const startedAt = Date.now();
  const { db, sessionId, signal } = input;
  const llm = input.llm ?? getLlmProvider();
  const tts = input.tts ?? getTtsProvider();

  const utterance = input.utterance.trim();
  if (!utterance) {
    yield { type: 'error', message: 'Nothing was said.' };
    return;
  }

  let firstAudioAt: number | null = null;
  let llmMs = 0;
  let toolMs = 0;

  // --- reconcile the previous turn before anything else --------------------
  // If the user cut the assistant off, the record of that turn is rewritten to
  // what they heard *before* this turn's history is read. Otherwise the model
  // would see its own unheard sentence as context for the correction.
  let state: LoadedState = await loadCookingState(db, sessionId);
  if (input.interruption) {
    await markInterrupted(
      db,
      sessionId,
      input.interruption.turnIndex,
      input.interruption.heardText,
      { interruptionLatencyMs: input.interruption.latencyMs },
    );
    state = { ...state, session: await recordCorrection(db, state, utterance) };
  }

  const turnIndex = await nextTurnIndex(db, sessionId);
  yield { type: 'turn.start', turnIndex, transcript: utterance };
  yield { type: 'state', state: state.snapshot };

  // --- context -------------------------------------------------------------
  const [allMemory, profile, history] = await Promise.all([
    listMemory(db, 100),
    getProfile(db),
    recentTurns(db, sessionId, 12),
  ]);
  const preferences: Preferences = profile?.preferences ?? {};
  const memory = selectRelevantMemory(allMemory, utterance, 6);

  await recordTurn(db, { sessionId, turnIndex, role: 'user', text: utterance });

  const messages = buildMessages({
    state: state.snapshot,
    memory,
    preferences,
    history,
    utterance,
  });

  const toolContext: ToolContext = {
    db,
    state,
    reload: async () => {
      state = await loadCookingState(db, sessionId);
      return state;
    },
  };

  let assistantText = '';
  let completed = false;

  try {
    // --- pass 1: answer, or decide which tools to call ---------------------
    const llmStart = Date.now();
    const first = await llm.complete(messages, toolSchemas(), signal);
    llmMs += Date.now() - llmStart;

    if (first.toolCalls.length === 0) {
      assistantText = first.content.trim();
    } else {
      // Delegated with `yield*` rather than collected: the filler has to reach
      // the browser *while* the tool is still running, so these events cannot
      // be buffered until the batch finishes.
      const toolMessages = yield* runTools(first.toolCalls, toolContext, signal, tts, () => {
        if (firstAudioAt === null) firstAudioAt = Date.now();
      });
      toolMs = toolMessages.toolMs;

      // A tool that changed the state (scaling, a timer, a step move) must be
      // reflected in the UI and in the follow-up prompt.
      if (toolMessages.stateChanged) {
        state = await toolContext.reload();
        yield { type: 'state', state: state.snapshot };
      }

      const followUp: ChatMessage[] = [
        ...buildMessages({ state: state.snapshot, memory, preferences, history, utterance }),
        { role: 'assistant', content: first.content ?? '', toolCalls: first.toolCalls },
        ...toolMessages.messages,
      ];

      // Streamed, so the first clause can be spoken while the rest is written.
      const streamStart = Date.now();
      const noteAudio = () => {
        if (firstAudioAt === null) firstAudioAt = Date.now();
      };
      const spoken = yield* speakStream(llm.stream(followUp, signal), tts, signal, noteAudio);
      llmMs += Date.now() - streamStart;
      assistantText = spoken;

      // Some models occasionally return an empty message after a tool call.
      // The user has already heard a filler by this point, so returning
      // nothing leaves them with "let me check that..." followed by silence —
      // the exact dead air the filler exists to prevent. Retry once without
      // streaming, and if that is empty too, say so rather than going quiet.
      if (!assistantText.trim() && !signal.aborted) {
        const retryStart = Date.now();
        const retry = await llm.complete(followUp, [], signal);
        llmMs += Date.now() - retryStart;
        assistantText = retry.content.trim() || EMPTY_ANSWER_FALLBACK;
        yield* speakText(assistantText, tts, signal, noteAudio);
      }
    }

    // The no-tool path already has its full text; speak it in clauses.
    if (first.toolCalls.length === 0 && assistantText) {
      yield* speakText(assistantText, tts, signal, () => {
        if (firstAudioAt === null) firstAudioAt = Date.now();
      });
    }

    completed = !signal.aborted;
  } catch (error) {
    if (isAbort(error) || signal.aborted) {
      // Barge-in. The `finally` below cancels Rime and records the partial
      // turn; there is nothing left to say, because the client is silent.
      return;
    }
    console.error('[orchestrator]', error);

    const message =
      error instanceof AppError && error.message
        ? error.message
        : 'Sorry, something went wrong there. Try me again.';

    yield { type: 'error', message };

    // Say it, do not just display it.
    //
    // The cook's hands are wet and their attention is on the pan; a red box on
    // a screen they are not looking at is indistinguishable from the assistant
    // having simply ignored them. A hands-free product that fails silently is
    // broken by its own premise, so the failure gets spoken like anything else.
    try {
      yield* speakText(message, tts, signal, () => {
        if (firstAudioAt === null) firstAudioAt = Date.now();
      });
    } catch {
      // TTS is very likely the thing that just failed. Nothing further to try.
    }
    return;
  } finally {
    // Reached on a thrown abort *and* on the generator being closed by the
    // route when the browser cancels the request — which is the normal path
    // for a barge-in. Persisting here is what gives the next turn's ledger a
    // row to rewrite with the words that were actually heard.
    if (!completed) {
      tts.cancel();
      await persistAssistant(db, sessionId, turnIndex, assistantText, true, startedAt);
    }
  }

  // A provider that ends quietly on abort (rather than throwing) must not fall
  // through to a completed turn: `turn.end` would tell the browser the
  // assistant finished saying something the user cut off.
  if (!completed) return;

  await persistAssistant(db, sessionId, turnIndex, assistantText, false, startedAt);

  const metrics: TurnMetrics = {
    timeToFirstAudioMs: firstAudioAt === null ? null : firstAudioAt - startedAt,
    totalMs: Date.now() - startedAt,
    toolMs,
    llmMs,
    interrupted: false,
  };
  yield { type: 'turn.end', turnIndex, text: assistantText, metrics };
}

// ---------------------------------------------------------------------------

type ToolRunOutcome = {
  messages: ChatMessage[];
  stateChanged: boolean;
  toolMs: number;
};

/**
 * Runs the model's tool calls, speaking a filler if the first one is slow
 * enough to leave a gap (voice feature 3).
 *
 * Two properties this has to hold:
 *
 *  - The filler is spoken *while* the tool is in flight, which is why the
 *    caller delegates with `yield*` instead of awaiting a collected list.
 *  - The filler never claims a result. "Let me recalculate that" is safe to
 *    say before the number exists; "you'll need six hundred grams" is not.
 *    The wording lives on each tool definition for exactly that reason.
 */
async function* runTools(
  calls: ToolCall[],
  ctx: ToolContext,
  signal: AbortSignal,
  tts: TtsProvider,
  onAudio: () => void,
): AsyncGenerator<TurnEvent, ToolRunOutcome> {
  const messages: ChatMessage[] = [];
  let stateChanged = false;
  let toolMs = 0;

  const started = Date.now();
  // Started before anything is yielded, so tool latency overlaps the filler
  // rather than following it.
  const running = calls.map((call) => ({
    call,
    promise: executeTool(call.name, call.arguments, ctx, signal),
  }));

  for (const { call } of running) {
    yield { type: 'tool.start', id: call.id, name: call.name };
  }

  const first = running[0];
  if (first) {
    const filler = fillerFor(first.call.name, started);
    if (filler) {
      const settledEarly = await Promise.race([
        first.promise.then(
          () => true,
          () => true,
        ),
        sleep(FILLER_THRESHOLD_MS).then(() => false),
      ]);
      if (!settledEarly && !signal.aborted) {
        yield { type: 'filler', text: filler, tool: first.call.name };
        yield* speakSegment(filler, tts, signal, onAudio, 'quick');
      }
    }
  }

  for (const { call, promise } of running) {
    const outcome = await promise;
    toolMs = Math.max(toolMs, Date.now() - started);
    stateChanged = stateChanged || outcome.stateChanged;
    yield { type: 'tool.end', id: call.id, name: call.name, ok: outcome.ok, ms: outcome.durationMs };
    messages.push({
      role: 'tool',
      content: outcome.content,
      toolCallId: call.id,
      name: call.name,
    });
  }

  return { messages, stateChanged, toolMs };
}

/**
 * Speak a completed piece of text, one clause at a time.
 *
 * Each clause gets its own speech profile, so a reply that mixes explanation
 * and a measurement slows down only for the measurement.
 */
async function* speakText(
  text: string,
  tts: TtsProvider,
  signal: AbortSignal,
  onAudio: () => void,
): AsyncGenerator<TurnEvent> {
  for (const segment of segmentForSpeech(text)) {
    if (signal.aborted) return;
    yield* speakSegment(segment, tts, signal, onAudio);
  }
}

/** Buffers a token stream into clauses and speaks each as soon as it is whole. */
async function* speakStream(
  deltas: AsyncIterable<string>,
  tts: TtsProvider,
  signal: AbortSignal,
  onAudio: () => void,
): AsyncGenerator<TurnEvent, string> {
  let buffer = '';
  let spokenSoFar = '';

  for await (const delta of deltas) {
    if (signal.aborted) break;
    buffer += delta;

    // Speak on sentence boundaries only. Splitting mid-clause makes the
    // prosody audibly wrong, which costs more than the latency it saves.
    const boundary = lastBoundary(buffer);
    if (boundary > 0) {
      const ready = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary);
      if (ready) {
        spokenSoFar += (spokenSoFar ? ' ' : '') + ready;
        yield* speakText(ready, tts, signal, onAudio);
      }
    }
  }

  const tail = buffer.trim();
  if (tail && !signal.aborted) {
    spokenSoFar += (spokenSoFar ? ' ' : '') + tail;
    yield* speakText(tail, tts, signal, onAudio);
  }

  return spokenSoFar.trim();
}

function lastBoundary(text: string): number {
  const match = /[.!?](?=\s|$)/g;
  let index = -1;
  let found: RegExpExecArray | null;
  while ((found = match.exec(text)) !== null) index = found.index + 1;
  return index;
}

async function* speakSegment(
  segment: string,
  tts: TtsProvider,
  signal: AbortSignal,
  onAudio: () => void,
  profileHint?: SpeechProfileName,
): AsyncGenerator<TurnEvent> {
  const profile = selectProfile(segment, profileHint);
  const spoken = toSpeakable(segment, { precise: profile.name === 'precise' });
  if (!spoken) return;

  const contextId = randomUUID();
  yield { type: 'assistant.text', text: segment, profile: profile.name, contextId };

  for await (const event of tts.speak({ text: spoken, contextId, profile }, signal)) {
    if (signal.aborted) return;
    if (event.type === 'audio') {
      onAudio();
      yield {
        type: 'audio',
        contextId: event.contextId,
        seq: event.seq,
        pcm: event.pcm.toString('base64'),
      };
    } else if (event.type === 'timestamps') {
      yield {
        type: 'timestamps',
        contextId: event.contextId,
        words: event.words,
        start: event.start,
        end: event.end,
      };
    } else {
      yield { type: 'speech.end', contextId: event.contextId };
    }
  }
}

async function persistAssistant(
  db: Db,
  sessionId: string,
  turnIndex: number,
  text: string,
  interrupted: boolean,
  startedAt: number,
): Promise<void> {
  if (!text.trim()) return;
  try {
    await recordTurn(db, {
      sessionId,
      turnIndex,
      role: 'assistant',
      text,
      // Left null on an interrupted turn: the browser reports the real cut
      // point on the next request, and guessing here would be a worse answer
      // than none.
      heardText: null,
      interrupted,
      metrics: { totalMs: Date.now() - startedAt },
    });
  } catch (error) {
    console.error('[orchestrator] could not persist assistant turn', error);
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
