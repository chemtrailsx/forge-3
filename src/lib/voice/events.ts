import type { CookingStateSnapshot } from '../types';
import type { SpeechProfileName } from '../tts/types';

/**
 * The server → client event stream for one turn.
 *
 * Audio travels inside this same stream rather than over a second request, so
 * that aborting the turn is a single act: the browser cancels one fetch, and
 * the server's abort handler cancels Rime, the model and any in-flight tool
 * together. Two channels would let one of them survive a barge-in.
 */

export type TurnMetrics = {
  /** Request received → first audio byte leaving the server. */
  timeToFirstAudioMs: number | null;
  /** Request received → turn complete. */
  totalMs: number;
  toolMs: number;
  llmMs: number;
  interrupted: boolean;
};

export type TurnEvent =
  | { type: 'turn.start'; turnIndex: number; transcript: string }
  | { type: 'state'; state: CookingStateSnapshot }
  | { type: 'filler'; text: string; tool: string }
  | { type: 'tool.start'; id: string; name: string }
  | { type: 'tool.end'; id: string; name: string; ok: boolean; ms: number }
  | { type: 'assistant.text'; text: string; profile: SpeechProfileName; contextId: string }
  | { type: 'audio'; contextId: string; seq: number; pcm: string }
  | { type: 'timestamps'; contextId: string; words: string[]; start: number[]; end: number[] }
  | { type: 'speech.end'; contextId: string }
  | { type: 'turn.end'; turnIndex: number; text: string; metrics: TurnMetrics }
  | { type: 'error'; message: string };

/** Server-Sent Events framing. One JSON object per event. */
export function encodeSse(event: TurnEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function parseSseLine(line: string): TurnEvent | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as TurnEvent;
  } catch {
    return null;
  }
}
