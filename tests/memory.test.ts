import { describe, expect, it } from 'vitest';
import { listMemory, saveMemory, deleteMemory } from '@/lib/db/memory';
import { selectRelevantMemory, scoreMemory, tokenize } from '@/lib/memory/retrieval';
import { historyToMessages } from '@/lib/llm/prompt';
import type { MemoryEntry } from '@/lib/types';
import { ALICE, makeDb, seedTables } from './helpers/fixtures';

const entry = (key: string, value: string, kind: MemoryEntry['kind'] = 'preference'): MemoryEntry => ({
  id: key,
  key,
  value,
  kind,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const CORPUS: MemoryEntry[] = [
  entry('spice_level', 'does not like very spicy food'),
  entry('walnut_allergy', 'allergic to walnuts', 'avoidance'),
  entry('usual_servings', 'usually cooks for four'),
  entry('pasta_note', 'prefers bronze-cut spaghetti', 'note'),
  entry('coffee', 'drinks decaf after six', 'note'),
];

describe('relevance selection', () => {
  it('returns only memory related to what was said', () => {
    const selected = selectRelevantMemory(CORPUS, 'how much spaghetti for the pasta?');
    const keys = selected.map((item) => item.key);

    expect(keys).toContain('pasta_note');
    // Unrelated facts must not ride along; the model applies whatever it sees.
    expect(keys).not.toContain('coffee');
  });

  it('always surfaces avoidances, even when unmentioned', () => {
    const selected = selectRelevantMemory(CORPUS, 'what is next?');
    expect(selected.map((item) => item.key)).toContain('walnut_allergy');
  });

  it('respects the limit so the whole store is never sent', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`pasta_${i}`, `pasta fact ${i}`));
    const selected = selectRelevantMemory(many, 'pasta', 6);
    expect(selected).toHaveLength(6);
  });

  it('returns nothing when nothing is relevant', () => {
    const selected = selectRelevantMemory([entry('coffee', 'drinks decaf', 'note')], 'boil water');
    expect(selected).toEqual([]);
  });

  it('scores an avoidance above an unrelated preference', () => {
    const terms = tokenize('what should I do next');
    expect(scoreMemory(entry('nuts', 'allergic to walnuts', 'avoidance'), terms)).toBeGreaterThan(
      scoreMemory(entry('coffee', 'drinks decaf', 'note'), terms),
    );
  });

  it('drops stopwords so common words do not match everything', () => {
    expect(tokenize('how much of the butter is in it')).toEqual(['much', 'butter']);
  });
});

describe('memory persistence', () => {
  it('normalises keys and updates in place rather than duplicating', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    await saveMemory(db, 'Spice_Level', 'now enjoys medium heat');
    const all = await listMemory(db);
    const spice = all.filter((item) => item.key === 'spice_level');

    expect(spice).toHaveLength(1);
    expect(spice[0]?.value).toBe('now enjoys medium heat');
  });

  it('lets the user delete a single memory', async () => {
    const tables = seedTables();
    const { db } = makeDb(ALICE, tables);

    const before = await listMemory(db);
    const target = before.find((item) => item.key === 'spice_level');
    expect(target).toBeDefined();

    await deleteMemory(db, target!.id);

    const after = await listMemory(db);
    expect(after.map((item) => item.key)).not.toContain('spice_level');
    // Deleting one must not touch the rest.
    expect(after.map((item) => item.key)).toContain('allergy');
  });
});

describe('history reconstruction', () => {
  it('replays only what the user heard from an interrupted turn', () => {
    const messages = historyToMessages([
      {
        id: '1',
        turnIndex: 0,
        role: 'user',
        text: 'what next?',
        heardText: null,
        interrupted: false,
        createdAt: '',
      },
      {
        id: '2',
        turnIndex: 0,
        role: 'assistant',
        text: 'Drain the pasta and add it to the butter.',
        heardText: 'Drain the pasta and',
        interrupted: true,
        createdAt: '',
      },
    ]);

    const assistant = messages[1];
    expect(assistant?.content).toContain('Drain the pasta and');
    expect(assistant?.content).toContain('cut off');
    // The unheard half must never be replayed as though it were said.
    expect(assistant?.content).not.toContain('add it to the butter');
  });
});
