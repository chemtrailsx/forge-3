import { z } from 'zod';
import { assertOk, type Db } from './context';
import { parseOrDefault } from '../validation';

/**
 * Structured, high-frequency settings live here rather than in `user_memory`,
 * because they are read on every single turn and have a fixed shape. Free-form
 * facts ("I don't like very spicy food") stay in user_memory.
 */
export const preferencesSchema = z
  .object({
    defaultServings: z.number().int().min(1).max(50).optional(),
    spiceLevel: z.enum(['mild', 'medium', 'hot']).optional(),
    dietary: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    units: z.enum(['metric', 'imperial']).optional(),
    /**
     * ISO 3166-1 alpha-2 country code.
     *
     * Where the cook is decides what they can actually buy, what a dish is
     * called, and which measurements mean anything to them. Without it the
     * model answers from the centre of gravity of its training data — which is
     * how "what coffee should I buy" comes back recommending roasters that do
     * not sell in the country the cook is standing in.
     */
    region: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/)
      .transform((code) => code.toUpperCase())
      .optional(),
  })
  .default({});

export type Preferences = z.infer<typeof preferencesSchema>;

export type Profile = {
  id: string;
  displayName: string | null;
  preferences: Preferences;
};

export async function getProfile(db: Db): Promise<Profile | null> {
  const { data, error } = await db.supabase
    .from('profiles')
    .select('id, display_name, preferences')
    .eq('id', db.userId)
    .maybeSingle();

  assertOk(error, 'profile');
  if (!data) return null;

  const row = data as { id: string; display_name: string | null; preferences: unknown };
  return {
    id: row.id,
    displayName: row.display_name,
    preferences: parseOrDefault(preferencesSchema, row.preferences, {} as Preferences),
  };
}

export async function updatePreferences(db: Db, patch: Preferences): Promise<Preferences> {
  const current = await getProfile(db);
  const merged = { ...(current?.preferences ?? {}), ...patch };

  const { data, error } = await db.supabase
    .from('profiles')
    .upsert({ id: db.userId, preferences: merged }, { onConflict: 'id' })
    .select('preferences')
    .single();

  assertOk(error, 'profile');
  return parseOrDefault(preferencesSchema, (data as { preferences: unknown }).preferences, merged);
}
