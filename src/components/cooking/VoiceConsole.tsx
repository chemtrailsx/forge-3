'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IngredientPanel } from './IngredientPanel';
import { StepPanel } from './StepPanel';
import { TimerPanel } from './TimerPanel';
import { TranscriptFeed } from './TranscriptFeed';
import type { CookingStateSnapshot } from '@/lib/types';
import type { TurnMetrics } from '@/lib/voice/events';
import {
  VoiceClient,
  type TranscriptEntry,
  type VoiceStatus,
} from '@/lib/voice/voice-client';

const STATUS_LABEL: Record<VoiceStatus, { title: string; subtitle: string }> = {
  idle: { title: 'Tap to speak', subtitle: 'Hands-free culinary assistant' },
  listening: { title: 'Listening…', subtitle: 'Speak naturally, I am hearing you' },
  transcribing: { title: 'Processing…', subtitle: 'Understanding what you said' },
  thinking: { title: 'Thinking…', subtitle: 'Finding the best instruction' },
  speaking: { title: 'Speaking…', subtitle: 'Tap orb or speak firmly to pause' },
};

const SUGGESTIONS = [
  'Next step',
  'Repeat that',
  'How much time left?',
  'Ingredient checklist',
  'What can I substitute?',
];

export type ConsoleProps = {
  sessionId: string;
  initialState: CookingStateSnapshot;
  /**
   * What was already said in this session.
   *
   * Someone resuming is picking up a conversation, not starting one, and an
   * empty feed makes the app look like it has forgotten them — which is
   * exactly what it used to do.
   */
  initialTranscript?: TranscriptEntry[];
  sampleRate: number;
  ttsConfigured: boolean;
};

export function VoiceConsole({
  sessionId,
  initialState,
  initialTranscript = [],
  sampleRate,
  ttsConfigured,
}: ConsoleProps) {
  const [state, setState] = useState(initialState);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [entries, setEntries] = useState<TranscriptEntry[]>(initialTranscript);
  const [level, setLevel] = useState(0);
  const [tool, setTool] = useState<string | null>(null);
  const [filler, setFiller] = useState<string | null>(null);
  const [bargeIn, setBargeIn] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [canReplay, setCanReplay] = useState(false);
  const [notHeard, setNotHeard] = useState(false);
  const [replyMs, setReplyMs] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'ingredients' | 'timers' | 'transcript'>('transcript');

  const clientRef = useRef<VoiceClient | null>(null);

  const upsert = useCallback((entry: TranscriptEntry) => {
    setEntries((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index === -1) return [...current, entry];
      const next = [...current];
      next[index] = entry;
      return next;
    });
  }, []);

  useEffect(() => {
    const client = new VoiceClient(sampleRate, sessionId, {
      onStatus: (next) => {
        setStatus(next);
        // Re-checked here rather than when the text arrives: the transcript
        // event fires before any audio has been received, so at that point
        // there is nothing cached to replay yet. Status settles after the
        // audio does, on every path including an interrupted one.
        setCanReplay(clientRef.current?.canReplay ?? false);
      },
      onTranscript: upsert,
      onState: setState,
      onLevel: (rms) => setLevel(rms),
      onTool: (event) => setTool(event.phase === 'start' ? event.name : null),
      onFiller: (text) => {
        setFiller(text);
        window.setTimeout(() => setFiller(null), 2500);
      },
      onBargeIn: (latencyMs) => {
        setBargeIn(latencyMs);
        setEntries((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const entry = next[i];
            if (entry && entry.role === 'assistant') {
              next[i] = { ...entry, interrupted: true };
              break;
            }
          }
          return next;
        });
      },
      onMetrics: setMetrics,
      onResponseLatency: setReplyMs,
      onNotHeard: () => {
        setNotHeard(true);
        window.setTimeout(() => setNotHeard(false), 2200);
      },
      onError: setError,
    });
    clientRef.current = client;

    return () => {
      void client.stop();
      clientRef.current = null;
    };
  }, [sampleRate, sessionId, upsert]);

  async function toggle() {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    try {
      if (client.isRunning) await client.stop();
      else await client.start();
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied. You can type below instead.'
          : 'Could not open microphone. You can type below instead.',
      );
    }
  }

  async function replay() {
    await clientRef.current?.replayLast();
  }

  async function sendPrompt(text: string) {
    const query = text.trim();
    if (!query || !clientRef.current) return;
    setTyped('');
    await clientRef.current.sendText(query);
  }

  async function submitTyped(event: React.FormEvent) {
    event.preventDefault();
    await sendPrompt(typed);
  }

  // Soft visualizer waves
  const waveHeights = [
    Math.max(4, Math.min(20, Math.round(level * 350 * 0.7))),
    Math.max(4, Math.min(26, Math.round(level * 550 * 1.0))),
    Math.max(4, Math.min(28, Math.round(level * 750 * 1.3))),
    Math.max(4, Math.min(26, Math.round(level * 550 * 1.0))),
    Math.max(4, Math.min(20, Math.round(level * 350 * 0.7))),
  ];

  const activeTimersCount = state.timers.length;
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;

  return (
    <>
      {/*
        The session heading lives here, not on the page around it.
        Server-rendered it froze at whatever the dish was when the page loaded,
        so re-planning left the title of an abandoned dish sitting above the
        steps of the real one.
      */}
      <div className="session-heading">
        <div>
          <div className="section-label">Active Culinary Session</div>
          <h1 style={{ margin: 0, fontSize: '1.75rem', letterSpacing: '-0.02em' }}>
            {state.awaitingRecipe ? 'Ready when you are' : state.title}
          </h1>
        </div>
        {state.awaitingRecipe ? null : (
          <span className="badge servings" style={{ fontSize: '0.82rem', padding: '6px 14px' }}>
            {state.servings} {state.servings === 1 ? 'serving' : 'servings'}
          </span>
        )}
      </div>

      <div className="studio-layout">
      {/* Center / Left Main Stage */}
      <div className="stack" style={{ flex: 1, minWidth: 0, gap: 20 }}>
        {/* Step instruction banner */}
        <StepPanel state={state} />

        {/* 3D Iridescent Orb & Voice Stage */}
        <div
          style={{
            background: 'var(--surface)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(255, 255, 255, 0.95)',
            borderRadius: 'var(--radius-xl)',
            padding: '32px 28px 26px',
            boxShadow: 'var(--shadow-md)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Concentric Ripple Waves */}
          <div className="orb-container">
            <div className="ripple-wrapper">
              <div className="ripple-ring" />
              <div className="ripple-ring" />
              <div className="ripple-ring" />
            </div>

            <button
              className="pearl-orb"
              data-status={status}
              onClick={toggle}
              type="button"
              aria-label={STATUS_LABEL[status].title}
            >
              <svg
                className="orb-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>

            {/* Floor reflection puddle */}
            <div className="orb-reflection" />
          </div>

          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <h3
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '1.25rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                textTransform: 'none',
                letterSpacing: '-0.01em',
                margin: 0,
              }}
            >
              {STATUS_LABEL[status].title}
            </h3>
            <p className="muted small" style={{ margin: '4px 0 8px' }}>
              {STATUS_LABEL[status].subtitle}
            </p>

            {/*
              Replay, and the numbers behind the conversation.
              Moved out of the orb when the console was redesigned: the orb is
              the thing you look at from across a kitchen, and none of this is.
            */}
            <div className="row small" style={{ justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ghost small"
                onClick={replay}
                disabled={!canReplay}
                title="Play the last answer again"
              >
                ↻ Replay
              </button>
              <span className="muted">or just say &ldquo;say that again&rdquo;</span>
            </div>
            {notHeard ? (
              <div className="small" style={{ color: 'var(--accent-primary)', marginTop: 6 }}>
                Didn&rsquo;t catch that — say it again a little louder.
              </div>
            ) : null}
            <div className="small muted" style={{ marginTop: 6 }}>
              {filler ? <div>filler: “{filler}”</div> : null}
              {bargeIn !== null ? <div>last interruption stopped audio in {bargeIn} ms</div> : null}
              {replyMs !== null ? <div>replied {replyMs} ms after you stopped speaking</div> : null}
              {metrics ? (
                <div>
                  first audio{' '}
                  {metrics.timeToFirstAudioMs === null ? '—' : `${metrics.timeToFirstAudioMs} ms`} ·
                  turn {metrics.totalMs} ms
                  {metrics.toolMs ? ` · tool ${metrics.toolMs} ms` : ''}
                </div>
              ) : null}
            </div>
          </div>

          {/* Equalizer Waveform */}
          <div className="row" style={{ gap: 4, height: 26, marginBottom: 14 }}>
            {waveHeights.map((h, i) => (
              <div
                key={i}
                style={{
                  width: 4,
                  height: `${h}px`,
                  borderRadius: 2,
                  background: status === 'speaking' ? 'var(--speaking-color)' : 'var(--accent-primary)',
                  transition: 'height 0.08s ease, background 0.2s ease',
                }}
              />
            ))}
          </div>

          {/* Status Pills */}
          <div className="row" style={{ justifyContent: 'center', gap: 8, marginBottom: 14 }}>
            <span className={`badge${status === 'listening' ? ' on' : ''}`}>
              {status === 'listening' ? 'Mic Active' : 'Listening'}
            </span>
            <span className={`badge${status === 'speaking' ? ' on' : ''}`}>
              {status === 'speaking' ? 'Speaking' : 'Speech Out'}
            </span>
            {tool ? <span className="badge on">{tool}</span> : null}
          </div>

          {/* Live Spoken Subtitle / Speech Caption */}
          {latestEntry ? (
            <div className="live-caption-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: latestEntry.role === 'user' ? 'var(--text-secondary)' : 'var(--accent-primary)',
                  }}
                >
                  {latestEntry.role === 'user' ? 'You' : 'Companion'}
                </span>
                <span className="badge" style={{ fontSize: '0.66rem', padding: '1px 8px' }}>
                  Latest
                </span>
              </div>
              <div style={{ fontSize: '0.96rem', fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                {latestEntry.text}
              </div>
            </div>
          ) : null}

          {/* Quick action chips */}
          <div className="row" style={{ justifyContent: 'center', gap: 8, flexWrap: 'wrap', maxWidth: 560, marginTop: 14 }}>
            {SUGGESTIONS.map((item) => (
              <button
                key={item}
                type="button"
                className="pill-tag"
                onClick={() => void sendPrompt(item)}
              >
                {item}
              </button>
            ))}
          </div>

          {filler ? (
            <div className="small muted" style={{ marginTop: 12 }}>
              {filler}
            </div>
          ) : null}
          {bargeIn !== null ? (
            <div className="small muted" style={{ marginTop: 8 }}>
              Interrupted in {bargeIn} ms
            </div>
          ) : null}
          {metrics ? (
            <div className="small muted" style={{ marginTop: 8 }}>
              Latency: {metrics.timeToFirstAudioMs ?? '—'} ms &middot; Total turn: {metrics.totalMs} ms
            </div>
          ) : null}

          {!ttsConfigured ? (
            <div className="notice error" style={{ width: '100%', marginTop: 14 }}>
              Rime voice TTS is not configured. Set RIME_API_KEY in .env.
            </div>
          ) : null}
          {error ? (
            <div className="notice error" style={{ width: '100%', marginTop: 14 }}>
              {error}
            </div>
          ) : null}

          {/* Floating dock input bar */}
          <form onSubmit={submitTyped} className="dock-bar">
            <button
              type="button"
              className="ghost"
              onClick={toggle}
              style={{ padding: 6, color: status === 'listening' ? 'var(--listening-color)' : 'var(--text-muted)' }}
              title="Toggle microphone"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>

            <input
              className="dock-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Ask me anything or tap the orb to talk…"
              aria-label="Ask assistant"
            />

            <button type="submit" disabled={!typed.trim()} className="primary" style={{ padding: '7px 20px', fontSize: '0.84rem' }}>
              Send
            </button>
          </form>
        </div>
      </div>

      {/* Right Unified Studio Sidebar */}
      <div
        style={{
          background: 'var(--surface)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(255, 255, 255, 0.95)',
          borderRadius: 'var(--radius-xl)',
          padding: '24px',
          boxShadow: 'var(--shadow-md)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        {/* Segmented tab switcher */}
        <div className="tabs-header">
          <button
            type="button"
            className={`tab-button${activeTab === 'transcript' ? ' active' : ''}`}
            onClick={() => setActiveTab('transcript')}
          >
            Transcript ({entries.length})
          </button>
          <button
            type="button"
            className={`tab-button${activeTab === 'ingredients' ? ' active' : ''}`}
            onClick={() => setActiveTab('ingredients')}
          >
            Ingredients ({state.ingredients.length})
          </button>
          <button
            type="button"
            className={`tab-button${activeTab === 'timers' ? ' active' : ''}`}
            onClick={() => setActiveTab('timers')}
          >
            Timers {activeTimersCount > 0 ? `(${activeTimersCount})` : ''}
          </button>
        </div>

        {/* Tab content area */}
        <div style={{ flex: 1, minHeight: 0 }}>
          {activeTab === 'transcript' ? (
            <TranscriptFeed entries={entries} />
          ) : activeTab === 'ingredients' ? (
            <IngredientPanel state={state} />
          ) : (
            <TimerPanel timers={state.timers} />
          )}
        </div>
      </div>
    </div>
    </>
  );
}
