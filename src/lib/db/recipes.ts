import type { Recipe } from '../types';
import type { RecipeInput } from '../validation';
import { assertOk, type Db } from './context';
import { RECIPE_COLUMNS, toRecipe, type RecipeRow } from './rows';

export async function listRecipes(db: Db, limit = 50): Promise<Recipe[]> {
  const { data, error } = await db.supabase
    .from('recipes')
    .select(RECIPE_COLUMNS)
    .eq('user_id', db.userId)
    .order('is_favorite', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  assertOk(error, 'recipes');
  return ((data ?? []) as RecipeRow[]).map(toRecipe);
}

export async function getRecipe(db: Db, recipeId: string): Promise<Recipe | null> {
  const { data, error } = await db.supabase
    .from('recipes')
    .select(RECIPE_COLUMNS)
    .eq('user_id', db.userId)
    .eq('id', recipeId)
    .maybeSingle();

  assertOk(error, 'recipe');
  return data ? toRecipe(data as RecipeRow) : null;
}

/**
 * "Find my usual pasta recipe."
 *
 * Title match first, then ingredient match, both scoped to one user. The
 * ingredient pass uses a JSONB text cast rather than a join table because the
 * corpus is one person's recipe box — tens of rows, not millions — and the
 * simpler shape keeps the whole search inside a single RLS-filtered scan.
 */
export async function searchRecipes(db: Db, query: string, limit = 5): Promise<Recipe[]> {
  const term = query.trim();
  if (!term) return listRecipes(db, limit);

  const escaped = term.replace(/[%_,]/g, ' ').trim();
  if (!escaped) return listRecipes(db, limit);

  const { data, error } = await db.supabase
    .from('recipes')
    .select(RECIPE_COLUMNS)
    .eq('user_id', db.userId)
    .or(`title.ilike.%${escaped}%,ingredients.cs.[{"name":"${escaped.toLowerCase()}"}]`)
    .order('is_favorite', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  assertOk(error, 'recipes');
  const rows = ((data ?? []) as RecipeRow[]).map(toRecipe);
  if (rows.length > 0) return rows;

  // Fall back to a loose scan over the user's own (small) recipe box so a
  // partial phrase like "garlic butter" still finds "Weeknight Garlic Butter
  // Pasta" when the ilike above missed on word order.
  const all = await listRecipes(db, 100);
  const words = escaped.toLowerCase().split(/\s+/).filter(Boolean);
  return all
    .map((recipe) => ({ recipe, score: scoreRecipe(recipe, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.recipe);
}

function scoreRecipe(recipe: Recipe, words: string[]): number {
  const title = recipe.title.toLowerCase();
  const ingredients = recipe.ingredients.map((i) => i.name.toLowerCase()).join(' ');
  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += 2;
    else if (ingredients.includes(word)) score += 1;
  }
  return score;
}

export async function createRecipe(db: Db, input: RecipeInput): Promise<Recipe> {
  const { data, error } = await db.supabase
    .from('recipes')
    .insert({
      user_id: db.userId,
      title: input.title,
      ingredients: input.ingredients,
      steps: input.steps,
      servings: input.servings,
      source: input.source ?? null,
    })
    .select(RECIPE_COLUMNS)
    .single();

  assertOk(error, 'recipe');
  return toRecipe(data as RecipeRow);
}

export async function setFavorite(db: Db, recipeId: string, isFavorite: boolean): Promise<void> {
  const { error } = await db.supabase
    .from('recipes')
    .update({ is_favorite: isFavorite })
    .eq('user_id', db.userId)
    .eq('id', recipeId);

  assertOk(error, 'recipe');
}

export async function deleteRecipe(db: Db, recipeId: string): Promise<void> {
  const { error } = await db.supabase
    .from('recipes')
    .delete()
    .eq('user_id', db.userId)
    .eq('id', recipeId);

  assertOk(error, 'recipe');
}
