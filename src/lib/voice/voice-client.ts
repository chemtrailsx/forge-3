'use client';

import { PcmPlayer } from '../audio/pcm-player';
import { UtteranceRecorder } from '../audio/recorder';
import { DEFAULT_VAD, VoiceActivityDetector } from '../audio/vad';
import type { CookingStateSnapshot } from '../types';
import { shouldBackchannel } from './backchannel';
import { parseSseLine, type TurnEvent, type TurnMetrics } from './events';
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
};

export type VoiceClientEvents = {
  onStatus: (status: VoiceStatus) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onState: (state: CookingStateSnapshot) => void;
  onLevel: (rms: number, floor: number) => void;
  onTool: (event: { name: string; phase: 'start' | 'end'; ok?: boolean; ms?: number }) => void;
  onFiller: (text: string) => void;
  onBargeIn: (latencyMs: number) => void;
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
const NUDGE_POLL_MS = 5000;

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

  /** Set when the last assistant turn was cut off, consumed by the next turn. */
  private pendingInterruption: InterruptionReport | null = null;
  private currentTurnIndex = -1;
  private backchannelCount = 0;
  private lastBackchannelAt: number | null = null;
  private speechStartedAt = 0;
  private nudgeTimer: number | null = null;
  private nudgeInFlight = false;
  private lastNudgeAt: number | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly sessionId: string,
    private readonly events: VoiceClientEvents,
  ) {
    this.tracker = new HeardTracker(sampleRate);
    this.player = new PcmPlayer(sampleRate, {
      onPlayingChange: (playing) => {
        this.assistantSpeaking = playing;
        if (!playing && this.status === 'speaking') this.setResting();
        else if (playing) this.setStatus('speaking');
      },
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.player.init();
    await this.player.resume();
    await this.openMicrophone();
    this.running = true;
    this.setStatus('listening');
    this.startNudgePolling();
  }

  async stop(): Promise<void> {
    this.running = false;
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
      if (body.state) this.events.onState(body.state);
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
    this.setStatus(this.running ? 'listening' : 'idle');
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

  private async onLevel(rms: number): Promise<void> {
    if (!this.running) return;
    this.events.onLevel(rms, this.vad.floor);

    const event = this.vad.push(rms, VAD_WINDOW_MS);

    if (event === 'speech-start') {
      this.speechStartedAt = performance.now();
      if (this.assistantSpeaking || this.turnController) await this.bargeIn();
      this.recorder?.beginUtterance();
      this.backchannelCount = 0;
      this.lastBackchannelAt = null;
      return;
    }

    if (event === 'speech-end') {
      const utterance = this.recorder?.endUtterance() ?? null;
      if (utterance) void this.handleUtterance(utterance);
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

    const heardText = this.tracker.heardText(this.player.progress());
    if (this.currentTurnIndex >= 0) {
      this.pendingInterruption = { turnIndex: this.currentTurnIndex, heardText, latencyMs };
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

  private async handleUtterance(audio: Blob): Promise<void> {
    this.setStatus('transcribing');

    let transcript = '';
    try {
      const form = new FormData();
      // Named from the blob's own type: a filename that disagrees with the
      // bytes is how a valid upload still gets rejected as unreadable.
      const extension = audio.type.includes('wav') ? 'wav' : 'webm';
      form.append('audio', audio, `utterance.${extension}`);
      const response = await fetch('/api/stt', { method: 'POST', body: form });
      if (!response.ok) {
        this.events.onError(await errorMessage(response));
        this.setResting();
        return;
      }
      transcript = ((await response.json()) as { text?: string }).text?.trim() ?? '';
    } catch {
      this.events.onError('Could not reach speech recognition.');
      this.setResting();
      return;
    }

    if (!transcript) {
      this.setResting();
      return;
    }

    this.events.onTranscript({ id: cryptoId(), role: 'user', text: transcript });
    await this.runTurn(transcript);
  }

  private async runTurn(transcript: string): Promise<void> {
    this.setStatus('thinking');
    this.tracker.reset();

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
        this.events.onTranscript({
          id: assistantId,
          role: 'assistant',
          text: assistantText,
          profile: event.profile,
        });
        break;
      }
      case 'audio': {
        const samples = Math.floor((event.pcm.length * 3) / 4 / 2);
        this.tracker.addSamples(event.contextId, samples);
        this.player.enqueueBase64(event.contextId, event.pcm);
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

  /** Typed input, for testing the loop without a microphone. */
  async sendText(text: string): Promise<void> {
    if (this.assistantSpeaking || this.turnController) await this.bargeIn();
    this.events.onTranscript({ id: cryptoId(), role: 'user', text });
    await this.runTurn(text);
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
