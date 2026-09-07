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

/**
 * The cooking screen.
 *
 * One large voice control, and everything else is glanceable context. There is
 * deliberately no way to drive the recipe by tapping: the product claim is that
 * you do not have to stop cooking to use it, and a button that does the same
 * job would quietly become the interface under test.
 *
 * A text box is kept for the demo and for a machine with no microphone. It
 * enters the same turn pipeline, including barge-in.
 */

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Tap to start',
  listening: 'Listening',
  transcribing: 'Heard you',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export type ConsoleProps = {
  sessionId: string;
  initialState: CookingStateSnapshot;
  sampleRate: number;
  ttsConfigured: boolean;
};

export function VoiceConsole({ sessionId, initialState, sampleRate, ttsConfigured }: ConsoleProps) {
  const [state, setState] = useState(initialState);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [tool, setTool] = useState<string | null>(null);
  const [filler, setFiller] = useState<string | null>(null);
  const [bargeIn, setBargeIn] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

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
      onStatus: setStatus,
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
        // Mark the assistant's last line as cut off, so the screen agrees with
        // what the ear heard.
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
          ? 'Microphone permission was denied. You can still type below.'
          : 'Could not open the microphone. You can still type below.',
      );
    }
  }

  async function submitTyped(event: React.FormEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (!text || !clientRef.current) return;
    setTyped('');
    await clientRef.current.sendText(text);
  }

  const meterWidth = Math.min(100, Math.round(level * 900));

  return (
    <div className="grid cook">
      <div className="stack">
        <StepPanel state={state} />

        <section className="card">
          <div className="row" style={{ gap: 20, alignItems: 'center' }}>
            <button className="mic" data-status={status} onClick={toggle} type="button">
              <span>{STATUS_LABEL[status]}</span>
              <span className="muted small">{status === 'idle' ? 'microphone' : 'tap to stop'}</span>
            </button>

            <div className="stack" style={{ flex: 1, minWidth: 200 }}>
              <div className="level" aria-hidden>
                <span style={{ width: `${meterWidth}%` }} />
              </div>
              <div className="row small">
                <span className={`badge${status === 'listening' ? ' on' : ''}`}>listening</span>
                <span className={`badge${status === 'speaking' ? ' on' : ''}`}>speaking</span>
                <span className={`badge${tool ? ' on' : ''}`}>{tool ?? 'no tool'}</span>
              </div>
              {filler ? <div className="small muted">filler: “{filler}”</div> : null}
              {bargeIn !== null ? (
                <div className="small muted">last interruption stopped audio in {bargeIn} ms</div>
              ) : null}
              {metrics ? (
                <div className="small muted">
                  first audio{' '}
                  {metrics.timeToFirstAudioMs === null ? '—' : `${metrics.timeToFirstAudioMs} ms`} ·
                  turn {metrics.totalMs} ms
                  {metrics.toolMs ? ` · tool ${metrics.toolMs} ms` : ''}
                </div>
              ) : null}
            </div>
          </div>

          {!ttsConfigured ? (
            <div className="notice error" style={{ marginTop: 14 }}>
              Rime is not configured, so there will be no spoken output. Set RIME_API_KEY in
              .env.local.
            </div>
          ) : null}
          {error ? (
            <div className="notice error" style={{ marginTop: 14 }}>
              {error}
            </div>
          ) : null}

          <form onSubmit={submitTyped} className="row" style={{ marginTop: 14 }}>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Or type, if you cannot speak right now"
              aria-label="Type a message"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={!typed.trim()}>
              Send
            </button>
          </form>
        </section>

        <TranscriptFeed entries={entries} />
      </div>

      <div className="stack">
        <TimerPanel timers={state.timers} />
        <IngredientPanel state={state} />
      </div>
    </div>
  );
}
