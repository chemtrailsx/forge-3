import { wordsHeard, type WordTimeline } from './heard-ledger';

/**
 * Browser-side accounting of what the user actually heard this turn.
 *
 * A turn is spoken as several contexts (one per clause). For each we know:
 *   - the words and their timings, when the streaming transport supplied them
 *   - how many samples were rendered to the output device
 *
 * On a barge-in those two give an exact cut point. The HTTP transport (used by
 * the quick and precise profiles) does not return word timings, so there is a
 * documented fallback: cut proportionally by the fraction of the segment's
 * audio that played. It is an estimate, and it is marked as one.
 */
export class HeardTracker {
  private order: string[] = [];
  private text = new Map<string, string>();
  private timelines = new Map<string, WordTimeline>();
  private received = new Map<string, number>();

  constructor(private readonly sampleRate: number) {}

  reset(): void {
    this.order = [];
    this.text.clear();
    this.timelines.clear();
    this.received.clear();
  }

  beginSegment(contextId: string, text: string): void {
    if (!this.order.includes(contextId)) this.order.push(contextId);
    this.text.set(contextId, text);
  }

  addSamples(contextId: string, sampleCount: number): void {
    this.received.set(contextId, (this.received.get(contextId) ?? 0) + sampleCount);
  }

  addTimeline(contextId: string, timeline: WordTimeline): void {
    const existing = this.timelines.get(contextId);
    if (!existing) {
      this.timelines.set(contextId, timeline);
      return;
    }
    // Rime may emit timestamps in several frames for one context.
    const offset = existing.end.length > 0 ? (existing.end[existing.end.length - 1] ?? 0) : 0;
    this.timelines.set(contextId, {
      words: [...existing.words, ...timeline.words],
      start: [...existing.start, ...timeline.start.map((t) => t + offset)],
      end: [...existing.end, ...timeline.end.map((t) => t + offset)],
    });
  }

  /** The text that reached the speaker, given per-context played sample counts. */
  heardText(playedByContext: Record<string, number>): string {
    const parts: string[] = [];

    for (const contextId of this.order) {
      const playedSamples = playedByContext[contextId] ?? 0;
      if (playedSamples === 0) break;

      const timeline = this.timelines.get(contextId);
      const segmentText = this.text.get(contextId) ?? '';

      if (timeline && timeline.words.length > 0) {
        const result = wordsHeard(timeline, playedSamples / this.sampleRate);
        if (result.heardText) parts.push(result.heardText);
        if (!result.complete) break;
      } else {
        const receivedSamples = this.received.get(contextId) ?? 0;
        const fraction = receivedSamples > 0 ? Math.min(1, playedSamples / receivedSamples) : 0;
        const words = segmentText.split(/\s+/).filter(Boolean);
        const kept = Math.floor(words.length * fraction);
        if (kept > 0) parts.push(words.slice(0, kept).join(' '));
        if (fraction < 1) break;
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
}
