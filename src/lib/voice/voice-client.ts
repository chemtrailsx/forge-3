'use client';

import { PcmPlayer } from '../audio/pcm-player';
import { UtteranceRecorder } from '../audio/recorder';
import { DEFAULT_VAD, VoiceActivityDetector } from '../audio/vad';
import type { CookingStateSnapshot } from '../types';
import { shouldBackchannel } from './backchannel';
import { parseSseLine, type TurnEvent, type TurnMetrics } from './events';
import { isReplayRequest } from './replay';
import { HeardTracker } from './heard-tracker';
import type { InterruptionReport } from './orchestrator';

/**
 * The browser half of the voice loop.
 *
 * Three things run concurrently and must never block one another:
 *   - the microphone, open continuously, including while Rime is speaking
 *   - the turn request, a single cancellable fetch carrying events and audio
 *   - PCM playback, which can be silenced within one render quantum
 *
 * Barge-in is the reason for that shape. When the VAD fires while audio is
 * playing we do four things in this order, and the order matters: stop the
 * speaker, cancel the request (which cancels Rime, the model and the tool
 * server-side), work out what the user actually heard, and only then start
 * capturing the correction.
 */

export type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
  profile?: string;
  /** A repeat of something already said, not a new answer. */
  replay?: boolean;
};

export type VoiceClientEvents = {
  onStatus: (status: VoiceStatus) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onState: (state: CookingStateSnapshot) => void;
  onLevel: (rms: number, floor: number) => void;
  onTool: (event: { name: string; phase: 'start' | 'end'; ok?: boolean; ms?: number }) => void;
  onFiller: (text: string) => void;
  onBargeIn: (latencyMs: number) => void;
  /** Something was captured but was too faint or too short to be speech. */
  onNotHeard: () => void;
  /** Milliseconds from the user falling silent to the first sound of a reply. */
  onResponseLatency: (ms: number) => void;
  onMetrics: (metrics: TurnMetrics) => void;
  onError: (message: string) => void;
};

const VAD_WINDOW_MS = 20;

/**
 * How often to ask whether anything needs saying unprompted.
 *
 * Five seconds is the coarsest resolution a cook would not notice — a pan that
 * finished is fine to hear about a few seconds later — and it keeps the poll
 * cheap enough to run for a whole session.
 */
const NUDGE_POLL_MS = 15000;

/**
 * How long after the speaker falls silent the assistant still counts as
 * holding the floor.
 *
 * Long enough to bridge a clause boundary, short enough that someone
 * answering the moment it stops is heard immediately.
 */
const SPEECH_HOLDOFF_MS = 700;

/** Roughly 40 seconds of 24 kHz mono audio, base64-encoded. */
const MAX_REPLAY_BYTES = 3_000_000;

export class VoiceClient {
  private player: PcmPlayer;
  private vad = new VoiceActivityDetector(DEFAULT_VAD);
  private recorder: UtteranceRecorder | null = null;
  private stream: MediaStream | null = null;
  private meter: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private tracker: HeardTracker;

  private turnController: AbortController | null = null;
  private status: VoiceStatus = 'idle';
  private assistantSpeaking = false;
  private running = false;
  /** The session is up; the mic may or may not be. */
  private micOpen = false;

  /** Set when the last assistant turn was cut off, consumed by the next turn. */
  private pendingInterruption: InterruptionReport | null = null;
  private currentTurnIndex = -1;
  private backchannelCount = 0;
  private lastBackchannelAt: number | null = null;
  private speechStartedAt = 0;
  /**
   * When the speaker last fell silent.
   *
   * `assistantSpeaking` flickers false in the gaps between clauses — and more
   * often since the jitter buffer, which re-primes whenever the queue empties.
   * Those gaps are precisely when the next clause is about to play, so letting
   * the microphone threshold drop back to normal there invites the assistant
   * to trigger on its own voice and start a turn nobody asked for.
   */
  private lastDrainedAt: number | null = null;
  private nudgeTimer: number | null = null;
  private nudgeInFlight = false;
  private lastNudgeAt: number | null = null;

  /**
   * Transcription started at a pause, before the turn has formally ended.
   *
   * The hangover has to be long enough to survive a mid-sentence pause, and
   * all of it is time the cook spends waiting. Running the transcription
   * inside that window hides most of it; if speech resumes, this is aborted
   * and thrown away.
   */
  private eager: { controller: AbortController; text: Promise<string | null> } | null = null;
  private speechEndedAt: number | null = null;

  /**
   * The audio of the most recent spoken answer, kept so it can be replayed
   * verbatim.
   *
   * One turn only, and dropped the moment the next one starts: this exists so
   * a cook who missed a quantity can hear that quantity again, not as a
   * history feature. A minute of speech is about 3 MB at this rate, so the cap
   * below is the difference between a convenience and a leak.
   */
  private lastSpoken: { contextId: string; pcm: string }[] = [];
  private lastSpokenText = '';
  /** Latest cooking state, kept for priming the transcriber. */
  private lastState: CookingStateSnapshot | null = null;
  private lastSpokenBytes = 0;
  private replaying = false;

  constructor(
    private readonly sampleRate: number,
    private readonly sessionId: string,
    private readonly events: VoiceClientEvents,
  ) {
    this.tracker = new HeardTracker(sampleRate);
    this.player = new PcmPlayer(sampleRate, {
      onPlayingChange: (playing) => {
        this.assistantSpeaking = playing;
        if (!playing) this.lastDrainedAt = performance.now();
        if (!playing && this.status === 'speaking') {
          if (!this.turnController) {
            this.setResting();
          }
        } else if (playing) {
          this.setStatus('speaking');
        }
      },
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Playback and the microphone are separate failure domains.
   *
   * The session comes up first — audio out, and the poll that lets the
   * assistant speak first — and only then is the microphone attempted. A
   * denied mic costs you talking *to* it; it must not also cost you being told
   * the pasta is done, which is exactly when someone whose hands are too messy
   * to hold a phone still needs to hear it.
   */
  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureAudio();

    this.running = true;
    this.startNudgePolling();

    try {
      await this.openMicrophone();
      this.micOpen = true;
      this.setStatus('listening');
    } catch (error) {
      // Rethrown so the UI can say the mic is unavailable, but the session
      // stays up around it.
      this.setStatus('idle');
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.micOpen = false;
    this.stopNudgePolling();
    this.turnController?.abort();
    this.turnController = null;
    await this.player.clear();
    this.recorder?.reset();
    this.recorder = null;
    this.meter?.disconnect();
    this.micSource?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.player.close();
    this.setStatus('idle');
  }

  // --- speaking first ------------------------------------------------------

  /**
   * Asks the server, every few seconds, whether anything needs saying.
   *
   * The cook cannot see the screen, so a finished pan has to announce itself.
   * The server owns the decision — see lib/voice/nudge.ts — because it owns
   * the timers, and because two open tabs must not both announce the same
   * pasta.
   */
  private startNudgePolling(): void {
    if (this.nudgeTimer !== null) return;
    this.nudgeTimer = window.setInterval(() => {
      void this.pollForNudge();
    }, NUDGE_POLL_MS);
  }

  private stopNudgePolling(): void {
    if (this.nudgeTimer !== null) window.clearInterval(this.nudgeTimer);
    this.nudgeTimer = null;
  }

  private async pollForNudge(): Promise<void> {
    // Never while a turn is in flight: the cook is mid-conversation, and
    // whatever needs saying will still need saying in five seconds.
    if (!this.running || this.nudgeInFlight || this.turnController) return;
    if (this.assistantSpeaking || this.vad.isSpeaking) return;

    // `turnController` is not set until the turn actually starts, which leaves
    // a gap: the cook has stopped talking and the utterance is still being
    // transcribed. Interrupting there would mean speaking over the answer they
    // are visibly waiting for — the worst-timed interruption available.
    if (this.status === 'transcribing' || this.status === 'thinking') return;

    this.nudgeInFlight = true;
    try {
      const response = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          assistantSpeaking: this.assistantSpeaking,
          userSpeaking: this.vad.isSpeaking,
          msSinceLastNudge:
            this.lastNudgeAt === null ? null : Math.round(performance.now() - this.lastNudgeAt),
        }),
      });
      if (!response.ok) return;

      const body = (await response.json()) as {
        speak: { text: string; contextId: string; turnIndex: number; pcm: string } | null;
        state?: CookingStateSnapshot;
      };
      if (body.state) {
        this.lastState = body.state;
        this.events.onState(body.state);
      }
      if (!body.speak) return;

      // The cook may have started talking while this was in flight. They win:
      // the reminder is already marked announced server-side, which is the
      // right trade — one missed reminder beats talking over them.
      if (this.vad.isSpeaking || this.turnController) return;

      this.lastNudgeAt = performance.now();
      this.currentTurnIndex = body.speak.turnIndex;
      this.tracker.reset();
      this.tracker.beginSegment(body.speak.contextId, body.speak.text);

      this.events.onTranscript({
        id: cryptoId(),
        role: 'assistant',
        text: body.speak.text,
        profile: 'precise',
      });
      this.player.enqueueBase64(body.speak.contextId, body.speak.pcm);
      this.player.flush();
    } catch {
      // A missed poll is a missed reminder, and the next one is seconds away.
    } finally {
      this.nudgeInFlight = false;
    }
  }

  private setStatus(status: VoiceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(status);
  }

  /**
   * Return to rest after a turn.
   *
   * "Listening" is a claim about the microphone, not about the app being idle.
   * A typed turn can run with the mic closed — or after it was denied — and
   * showing "Listening" there tells a cook whose hands are covered in flour
   * that they can just talk, when nothing is in fact hearing them.
   */
  private setResting(): void {
    this.setStatus(this.micOpen ? 'listening' : 'idle');
  }

  private async openMicrophone(): Promise<void> {
    const context = this.player.audioContext;
    if (!context) throw new Error('Audio is not initialised.');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Without echo cancellation the assistant hears its own voice through
        // the speakers and barges in on itself. On a device without it, use a
        // headset — noted in the README as a hardware dependency.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.stream = stream;
    this.recorder = new UtteranceRecorder(context.sampleRate);

    await context.audioWorklet.addModule('/worklets/mic-meter.js');
    const source = context.createMediaStreamSource(stream);
    const meter = new AudioWorkletNode(context, 'mic-meter');
    // Analysis only — the meter must never reach the speakers.
    source.connect(meter);

    meter.port.onmessage = (event: MessageEvent) => {
      const { rms, samples } = event.data as { rms: number; samples: Float32Array };
      // Buffered before the VAD is consulted, so the window that trips the
      // onset is already in the pre-roll rather than being the first thing
      // missing from it.
      this.recorder?.push(samples);
      void this.onLevel(rms);
    };

    this.micSource = source;
    this.meter = meter;
  }

  /**
   * Whether the assistant should be treated as holding the floor.
   *
   * Broader than "audio is playing right now": a turn still streaming, or a
   * clause boundary a moment ago, both mean more speech is imminent.
   */
  private assistantActive(): boolean {
    if (this.assistantSpeaking || this.turnController !== null) return true;
    return (
      this.lastDrainedAt !== null &&
      performance.now() - this.lastDrainedAt < SPEECH_HOLDOFF_MS
    );
  }

  private async onLevel(rms: number): Promise<void> {
    if (!this.running) return;
    this.events.onLevel(rms, this.vad.floor);

    // The threshold rises while the assistant is talking, so its own voice
    // coming back through the microphone does not read as a new turn — held
    // across the brief gaps between clauses, which are exactly the moments the
    // next clause is about to arrive.
    const event = this.vad.push(rms, VAD_WINDOW_MS, this.assistantActive());

    if (event === 'speech-pause') {
      this.startEagerTranscription();
      return;
    }

    if (event === 'speech-start') {
      this.speechStartedAt = performance.now();
      // They carried on, so the transcript begun at the pause is incomplete.
      this.cancelEagerTranscription();
      /*
       * Only interrupt something that is actually being said.
       *
       * This used to also fire whenever a turn was merely in flight, which
       * meant any noise during the ten seconds it takes to plan a recipe
       * killed that turn — and the noise itself was then discarded as not
       * speech, so nothing replaced it. The cook was left in silence having
       * done nothing wrong. A turn that has not produced audio yet is not
       * talking over anyone, so it is left alone until we know whether what we
       * just heard was really speech.
       */
      if (this.assistantSpeaking) await this.bargeIn();
      this.recorder?.beginUtterance();
      this.backchannelCount = 0;
      this.lastBackchannelAt = null;
      return;
    }

    if (event === 'speech-end') {
      this.speechEndedAt = performance.now();
      const speechLike = this.vad.looksLikeSpeech();
      const utterance = this.recorder?.endUtterance() ?? null;
      this.vad.reset();

      // Discarded here rather than uploaded, because a transcriber handed a
      // fragment of noise does not return nothing — it returns "Thank you.",
      // and the assistant answers a sentence the cook never said.
      //
      // Said out loud on the screen, because the alternative is a product that
      // ignores you without explanation. "It did not hear that" is a different
      // problem from "it is broken", and a cook who cannot tell them apart
      // just keeps talking to a machine that never answers.
      if (!utterance || !speechLike) {
        this.events.onNotHeard();
        return;
      }

      // Decided here instead, once we know it was speech: a real utterance
      // supersedes a turn still in flight, noise does not.
      void this.handleUtterance(utterance);
      return;
    }

    if (this.vad.isSpeaking) await this.maybeBackchannel();
  }

  /**
   * Barge-in.
   *
   * Playback is stopped before the request is aborted: the user must hear
   * silence immediately, and cancelling the network first would leave whatever
   * is already queued to keep playing over them.
   */
  private async bargeIn(): Promise<void> {
    const detectedAt = this.speechStartedAt || performance.now();

    await this.player.clear();
    const latencyMs = Math.round(performance.now() - detectedAt);

    if (this.replaying) {
      // Interrupting a replay is not an interruption of the turn it came
      // from: that turn finished, and was heard. Recording one would rewrite
      // its history to a fraction of what the cook actually heard.
      this.replaying = false;
    } else {
      const heardText = this.tracker.heardText(this.player.progress());
      if (this.currentTurnIndex >= 0) {
        this.pendingInterruption = { turnIndex: this.currentTurnIndex, heardText, latencyMs };
      }
    }

    this.turnController?.abort();
    this.turnController = null;
    this.assistantSpeaking = false;
    this.events.onBargeIn(latencyMs);
  }

  private async maybeBackchannel(): Promise<void> {
    const now = performance.now();
    const decision = shouldBackchannel({
      speechMs: this.vad.currentSpeechMs,
      msSinceLast: this.lastBackchannelAt === null ? null : now - this.lastBackchannelAt,
      countThisTurn: this.backchannelCount,
      assistantSpeaking: this.assistantSpeaking,
    });
    if (!decision) return;

    // Counted before the request so a slow response cannot produce a burst.
    this.backchannelCount += 1;
    this.lastBackchannelAt = now;

    try {
      const response = await fetch('/api/backchannel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: this.backchannelCount - 1 }),
      });
      if (!response.ok) return;
      // If the user stopped talking while this was in flight, the moment has
      // passed — playing it now would be the assistant taking the turn.
      if (!this.vad.isSpeaking || this.assistantSpeaking) return;

      const phrase = decodeURIComponent(response.headers.get('X-Phrase') ?? '');
      await this.player.playClip(await response.arrayBuffer(), 0.55);
      if (phrase) this.events.onFiller(phrase);
    } catch {
      // A backchannel is a nicety; failing to play one is not worth reporting.
    }
  }

/**
   * Begin transcribing at a pause, inside the hangover window.
   *
   * Safe because of what the hangover means: if it elapses, the cook did not
   * resume, so everything after this snapshot was silence and the snapshot is
   * the whole utterance. If they do resume, this is aborted before its result
   * is ever used.
   */
  private startEagerTranscription(): void {
    if (this.eager || !this.recorder) return;
    const audio = this.recorder.snapshot();
    if (!audio) return;

    const controller = new AbortController();
    this.eager = { controller, text: this.transcribe(audio, controller.signal) };
  }

  private cancelEagerTranscription(): void {
    this.eager?.controller.abort();
    this.eager = null;
  }

  /** Words worth priming the transcriber with, newest first. */
  private recognitionHint(): string {
    const state = this.lastState;
    return [
      this.lastSpokenText,
      state?.title ?? '',
      (state?.ingredients ?? []).map((ingredient) => ingredient.name).join(' '),
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 600);
  }

  /** One transcription request. Returns null if it failed or was abandoned. */
  private async transcribe(audio: Blob, signal: AbortSignal): Promise<string | null> {
    try {
      const form = new FormData();
      const extension = audio.type.includes('wav') ? 'wav' : 'webm';
      form.append('audio', audio, `utterance.${extension}`);

      /*
       * What the kitchen is currently talking about, sent along to bias
       * recognition. The assistant has usually just named the dishes, and the
       * cook's next sentence is made of those same words — which is precisely
       * the vocabulary a general-purpose transcriber gets wrong.
       */
      const hint = this.recognitionHint();
      if (hint) form.append('hint', hint);

      const response = await fetch('/api/stt', { method: 'POST', body: form, signal });
      if (!response.ok) {
        if (!signal.aborted) this.events.onError(await errorMessage(response));
        return null;
      }
      return ((await response.json()) as { text?: string }).text?.trim() ?? '';
    } catch {
      return null;
    }
  }

  private async handleUtterance(audio: Blob): Promise<void> {
    this.setStatus('transcribing');

    // Usually already running, and often already finished: it was started at
    // the pause, part-way through the hangover.
    const pending = this.eager;
    this.eager = null;

    const transcript = pending
      ? await pending.text
      : await this.transcribe(audio, new AbortController().signal);

    if (transcript === null) {
      this.events.onError('Could not reach speech recognition.');
      this.setResting();
      return;
    }

    if (!transcript) {
      this.setResting();
      return;
    }

    this.events.onTranscript({ id: cryptoId(), role: 'user', text: transcript });

    // A real utterance replaces a turn that is still being worked on. By this
    // point the clip has passed the energy gate and been transcribed, so we
    // know it is speech rather than a pan lid.
    if (this.turnController) await this.bargeIn();

    if (await this.handledAsReplay(transcript)) return;
    await this.runTurn(transcript);
  }

  /**
   * Answered from memory rather than by asking the model to repeat itself,
   * which would paraphrase — see lib/voice/replay.ts.
   *
   * Shared by the spoken and typed paths deliberately: they are the same
   * request, and letting one of them cost a round trip while the other does
   * not is the kind of difference nobody notices until it is confusing.
   */
  private async handledAsReplay(text: string): Promise<boolean> {
    if (!isReplayRequest(text)) return false;
    if (!(await this.replayLast())) return false;
    this.setResting();
    return true;
  }

  private async runTurn(transcript: string): Promise<void> {
    this.setStatus('thinking');
    this.tracker.reset();
    this.lastSpoken = [];
    this.lastSpokenText = '';
    this.lastSpokenBytes = 0;
    this.replaying = false;

    const controller = new AbortController();
    this.turnController = controller;

    const interruption = this.pendingInterruption;
    this.pendingInterruption = null;

    let assistantId = cryptoId();
    let assistantText = '';

    try {
      const response = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, transcript, interruption }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        this.events.onError(await errorMessage(response));
        this.setResting();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const event = parseSseLine(line.trim());
          if (!event) continue;
          const next = this.handleEvent(event, assistantId, assistantText);
          assistantId = next.assistantId;
          assistantText = next.assistantText;
        }
      }
    } catch (error) {
      // An abort here is a barge-in, which is a normal outcome, not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.events.onError('The assistant stopped responding.');
      }
    } finally {
      if (this.turnController === controller) this.turnController = null;
      // The stream is over, so nothing more will arrive for this turn. Tell
      // the player to drain rather than sit on a trailing clause that is
      // shorter than its cushion.
      this.player.flush();
      if (!this.assistantSpeaking) this.setResting();
    }
  }

  private handleEvent(
    event: TurnEvent,
    assistantId: string,
    assistantText: string,
  ): { assistantId: string; assistantText: string } {
    switch (event.type) {
      case 'turn.start':
        this.currentTurnIndex = event.turnIndex;
        break;
      case 'state':
        this.lastState = event.state;
        this.events.onState(event.state);
        break;
      case 'filler':
        this.events.onFiller(event.text);
        break;
      case 'tool.start':
        this.events.onTool({ name: event.name, phase: 'start' });
        break;
      case 'tool.end':
        this.events.onTool({ name: event.name, phase: 'end', ok: event.ok, ms: event.ms });
        break;
      case 'assistant.text': {
        this.tracker.beginSegment(event.contextId, event.text);
        assistantText = assistantText ? `${assistantText} ${event.text}` : event.text;
        this.lastSpokenText = assistantText;
        this.events.onTranscript({
          id: assistantId,
          role: 'assistant',
          text: assistantText,
          profile: event.profile,
        });
        break;
      }
      case 'audio': {
        // The only latency number that describes what the cook experiences:
        // from the moment they stopped talking to the moment sound comes out.
        // Server-side timings start when the request arrives, which omits the
        // hangover, the upload and the transcription — most of the wait.
        if (this.speechEndedAt !== null) {
          this.events.onResponseLatency(Math.round(performance.now() - this.speechEndedAt));
          this.speechEndedAt = null;
        }
        const samples = Math.floor((event.pcm.length * 3) / 4 / 2);
        this.tracker.addSamples(event.contextId, samples);
        this.player.enqueueBase64(event.contextId, event.pcm);

        // Kept so "say that again" can replay the exact audio rather than ask
        // the model to have another go at the same sentence.
        if (this.lastSpokenBytes + event.pcm.length <= MAX_REPLAY_BYTES) {
          this.lastSpoken.push({ contextId: event.contextId, pcm: event.pcm });
          this.lastSpokenBytes += event.pcm.length;
        }
        break;
      }
      case 'timestamps':
        this.tracker.addTimeline(event.contextId, {
          words: event.words,
          start: event.start,
          end: event.end,
        });
        break;
      case 'turn.end':
        this.events.onMetrics(event.metrics);
        break;
      case 'error':
        this.events.onError(event.message);
        break;
      default:
        break;
    }
    return { assistantId, assistantText };
  }

  /** Is there an answer to replay? Drives the button's enabled state. */
  get canReplay(): boolean {
    return this.lastSpoken.length > 0;
  }

  /**
   * Play the last answer again, exactly as it was said.
   *
   * From memory, so it is instant and costs nothing — and, more to the point,
   * it is the same words. Someone who missed "six hundred grams" needs that
   * number again, not a fresh attempt at the sentence that might phrase it
   * differently.
   */
  async replayLast(): Promise<boolean> {
    if (this.lastSpoken.length === 0) return false;

    await this.ensureAudio();
    await this.player.clear();

    this.replaying = true;
    // Fresh context ids: the played-sample counts feed the heard-transcript
    // ledger, and a replay must not be mistaken for the original being heard
    // twice over.
    for (const chunk of this.lastSpoken) {
      this.player.enqueueBase64(`replay:${chunk.contextId}`, chunk.pcm);
    }
    this.player.flush();

    this.events.onTranscript({
      id: cryptoId(),
      role: 'assistant',
      text: this.lastSpokenText,
      replay: true,
    });
    return true;
  }

  /**
   * Typed input — for a noisy room, a denied microphone, or a demo.
   *
   * The answer is still spoken. Typing changes how the question arrives, not
   * what the product is: someone types because they cannot talk right now, not
   * because they would rather read. Without this the audio was synthesised,
   * sent, and silently dropped by a player that had never been created,
   * because only the microphone button used to bring it up.
   *
   * Pressing Send is a user gesture, which is exactly what an AudioContext
   * needs in order to start.
   */
  async sendText(text: string): Promise<void> {
    await this.ensureAudio();
    if (this.assistantSpeaking || this.turnController) await this.bargeIn();
    this.events.onTranscript({ id: cryptoId(), role: 'user', text });
    if (await this.handledAsReplay(text)) return;
    await this.runTurn(text);
  }

  /** Brings up playback on its own, without requiring the microphone. */
  private async ensureAudio(): Promise<void> {
    await this.player.init();
    await this.player.resume();
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

function cryptoId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}
