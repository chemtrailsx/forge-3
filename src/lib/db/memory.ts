import type { MemoryEntry, MemoryKind } from '../types';
import { assertOk, type Db } from './context';
import { MEMORY_COLUMNS, toMemory, type MemoryRow } from './rows';

export async function listMemory(db: Db, limit = 100): Promise<MemoryEntry[]> {
  const { data, error } = await db.supabase
    .from('user_memory')
    .select(MEMORY_COLUMNS)
    .eq('user_id', db.userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  assertOk(error, 'memory');
  return ((data ?? []) as MemoryRow[]).map(toMemory);
}

/**
 * Upsert on (user_id, key) so restating a preference updates it rather than
 * accumulating contradictory rows the model would then have to arbitrate
 * between.
 */
export async function saveMemory(
  db: Db,
  key: string,
  value: string,
  kind: MemoryKind = 'preference',
): Promise<MemoryEntry> {
  const { data, error } = await db.supabase
    .from('user_memory')
    .upsert(
      { user_id: db.userId, key: key.trim().toLowerCase(), value: value.trim(), kind },
      { onConflict: 'user_id,key' },
    )
    .select(MEMORY_COLUMNS)
    .single();

  assertOk(error, 'memory');
  return toMemory(data as MemoryRow);
}

export async function deleteMemory(db: Db, id: string): Promise<void> {
  const { error } = await db.supabase
    .from('user_memory')
    .delete()
    .eq('user_id', db.userId)
    .eq('id', id);

  assertOk(error, 'memory');
}

export async function deleteAllMemory(db: Db): Promise<void> {
  const { error } = await db.supabase.from('user_memory').delete().eq('user_id', db.userId);
  assertOk(error, 'memory');
}
