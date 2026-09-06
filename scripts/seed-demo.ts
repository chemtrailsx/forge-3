/**
 * Seeds a second recipe and a past cooking session for one user, so the
 * personalisation half of the demo ("how did I make this last time?") has
 * something to retrieve.
 *
 *   npm run seed -- user@example.com
 *
 * This is the only place the service-role key is used: it writes on behalf of a
 * user without a browser session. Nothing in the app does that.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile('.env.local');
loadEnvFile('.env');

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run seed -- user@example.com');
    process.exit(1);
  }

  const { createAdminClient } = await import('../src/lib/supabase/admin');
  const supabase = createAdminClient();

  const { data: users, error: listError } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (listError) throw listError;

  const user = users.users.find((candidate) => candidate.email === email);
  if (!user) {
    console.error(`No user with email ${email}. Sign up in the app first.`);
    process.exit(1);
  }

  const { data: recipe, error: recipeError } = await supabase
    .from('recipes')
    .insert({
      user_id: user.id,
      title: 'Sunday Tomato Ragu',
      servings: 4,
      source: 'seed',
      is_favorite: true,
      ingredients: [
        { name: 'olive oil', quantity: 3, unit: 'tbsp' },
        { name: 'onion', quantity: 1, unit: null, note: 'finely diced' },
        { name: 'carrot', quantity: 1, unit: null, note: 'finely diced' },
        { name: 'garlic', quantity: 4, unit: 'cloves', note: 'crushed' },
        { name: 'tinned plum tomatoes', quantity: 800, unit: 'g' },
        { name: 'tomato puree', quantity: 2, unit: 'tbsp' },
        { name: 'basil', quantity: 15, unit: 'g' },
        { name: 'salt', quantity: null, unit: null },
      ],
      steps: [
        'Warm the olive oil in a heavy pan over medium-low heat.',
        'Soften the onion and carrot for ten minutes without colouring them.',
        'Stir in the garlic and tomato puree and cook for one minute.',
        'Add the tomatoes, crush them against the side of the pan, and season.',
        'Simmer uncovered for forty minutes, stirring now and then.',
        'Tear in the basil off the heat and check the seasoning.',
      ],
    })
    .select('id, title')
    .single();
  if (recipeError) throw recipeError;

  const { error: sessionError } = await supabase.from('cooking_sessions').insert({
    user_id: user.id,
    recipe_id: recipe.id,
    current_step: 5,
    status: 'finished',
    notes: {
      servings: 6,
      substitutions: [{ from: 'basil', to: 'flat-leaf parsley', note: '1 to 1' }],
      corrections: ['Wait, I doubled the tomatoes.'],
    },
  });
  if (sessionError) throw sessionError;

  const { error: memoryError } = await supabase.from('user_memory').upsert(
    [
      { user_id: user.id, key: 'usual_servings', value: 'usually cooks for four', kind: 'preference' },
      { user_id: user.id, key: 'spice_level', value: 'does not like very spicy food', kind: 'preference' },
    ],
    { onConflict: 'user_id,key' },
  );
  if (memoryError) throw memoryError;

  console.log(`Seeded "${recipe.title}", one finished session and two memories for ${email}.`);
}

function loadEnvFile(file: string): void {
  try {
    const contents = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Absent file is fine.
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
