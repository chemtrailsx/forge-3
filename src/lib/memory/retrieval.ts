import type { MemoryEntry } from '../types';

/**
 * Relevance selection for user memory.
 *
 * The rule from the spec is "retrieve only relevant memory, do not send the
 * user's whole database to the model on every turn". Two reasons it matters
 * beyond token cost: a long list of half-relevant facts makes the model apply
 * them indiscriminately ("you said you like it mild" while discussing dessert),
 * and every fact sent is a fact that can leak into an unrelated answer.
 *
 * The scoring is intentionally lexical rather than embedding-based. The corpus
 * is one person's kitchen preferences — tens of short rows — where term overlap
 * is accurate, needs no extra service, and is inspectable when it goes wrong.
 * `user_memory` has a place for an `embedding` column when that stops being
 * true.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'i', 'me', 'my', 'you',
  'it', 'to', 'of', 'in', 'on', 'for', 'with', 'do', 'does', 'how', 'what', 'this', 'that',
  'can', 'should', 'would', 'have', 'has', 'be', 'am', 'if', 'so', 'we', 'they', 'them',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

export type ScoredMemory = { entry: MemoryEntry; score: number };

export function scoreMemory(entry: MemoryEntry, terms: string[]): number {
  const haystack = `${entry.key.replace(/_/g, ' ')} ${entry.value}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
    // Cheap stem match, so "servings" hits a memory about "serving".
    else if (term.length > 4 && haystack.includes(term.slice(0, term.length - 1))) score += 1;
  }

  // Avoidances are safety-adjacent — an allergy must not fall out of the
  // window just because the user did not name it in this sentence.
  if (entry.kind === 'avoidance') score += 3;
  else if (entry.kind === 'preference') score += 1;

  return score;
}

export function selectRelevantMemory(
  entries: MemoryEntry[],
  utterance: string,
  limit = 6,
): MemoryEntry[] {
  if (entries.length === 0) return [];
  const terms = tokenize(utterance);

  return entries
    .map((entry) => ({ entry, score: scoreMemory(entry, terms) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
    .slice(0, limit)
    .map((scored) => scored.entry);
}
