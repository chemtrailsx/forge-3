/**
 * The heard-transcript ledger.
 *
 * When the user barges in, the assistant has usually said less than it
 * intended. The difference between "what was generated" and "what reached the
 * speaker" is invisible on the turn it happens and obvious two turns later,
 * when the assistant refers back to advice the user never heard.
 *
 * Rime's word timestamps plus the browser's played-sample count make that
 * difference measurable rather than guessed: the words whose end time is
 * before the playback cut are heard, the rest are not.
 *
 * Pure and isomorphic — the browser computes the cut, the server stores it,
 * and the same function is what the tests exercise.
 */

export type WordTimeline = {
  words: string[];
  /** Seconds from the start of the utterance. */
  start: number[];
  end: number[];
};

export type HeardResult = {
  heardText: string;
  heardWordCount: number;
  totalWordCount: number;
  complete: boolean;
};

/**
 * @param playedSeconds audio actually rendered to the output device, in
 *        seconds. Counted from samples, not from wall-clock time — a
 *        backgrounded tab keeps the clock running and stops the speaker.
 */
export function wordsHeard(timeline: WordTimeline, playedSeconds: number): HeardResult {
  const total = timeline.words.length;
  if (total === 0) {
    return { heardText: '', heardWordCount: 0, totalWordCount: 0, complete: true };
  }

  const heard: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const word = timeline.words[i];
    const endsAt = timeline.end[i];
    if (word === undefined) continue;
    // A word only counts as heard once its *end* has played. Half a word is
    // not information the user can act on.
    if (endsAt === undefined || endsAt <= playedSeconds) heard.push(word);
    else break;
  }

  return {
    heardText: joinWords(heard),
    heardWordCount: heard.length,
    totalWordCount: total,
    complete: heard.length === total,
  };
}

/** Rime emits punctuation attached to words; re-join without doubling spaces. */
function joinWords(words: string[]): string {
  return words
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge the timelines of consecutive segments in one turn.
 *
 * A turn is spoken as several clauses, each with its own context and its own
 * zero-based timeline. Offsetting each by the duration of the ones before it
 * turns them back into a single utterance the ledger can cut at one point.
 */
export function concatTimelines(timelines: WordTimeline[]): WordTimeline {
  const merged: WordTimeline = { words: [], start: [], end: [] };
  let offset = 0;

  for (const timeline of timelines) {
    for (let i = 0; i < timeline.words.length; i += 1) {
      const word = timeline.words[i];
      if (word === undefined) continue;
      merged.words.push(word);
      merged.start.push((timeline.start[i] ?? 0) + offset);
      merged.end.push((timeline.end[i] ?? 0) + offset);
    }
    const last = timeline.end.length > 0 ? timeline.end[timeline.end.length - 1] : 0;
    offset += last ?? 0;
  }

  return merged;
}
