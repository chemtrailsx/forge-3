import { z } from 'zod';
import { formatIngredient, scaleIngredients } from '../cooking/scale';
import { findSubstitution } from '../cooking/substitutions';
import { recordSubstitution, setServings } from '../cooking/state';
import { createRecipe, getRecipe, listRecipes, searchRecipes } from '../db/recipes';
import { listSessions } from '../db/sessions';
import { NotFoundError } from '../errors';
import { recipeInputSchema } from '../validation';
import { defineTool, jsonSchema } from './types';

/** Compact recipe shape for the model — full JSONB would waste the context. */
function summarize(recipe: {
  id: string;
  title: string;
  servings: number;
  ingredients: Parameters<typeof formatIngredient>[0][];
  steps: string[];
}) {
  return {
    recipe_id: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    ingredients: recipe.ingredients.map(formatIngredient),
    step_count: recipe.steps.length,
  };
}

export const getRecipeTool = defineTool({
  name: 'get_recipe',
  description:
    "Read one of the signed-in user's saved recipes in full, including every step. Use when the user asks what a recipe contains or wants to start cooking it.",
  schema: z.object({ recipe_id: z.string().uuid() }),
  parameters: jsonSchema(
    { recipe_id: jsonSchema.string('The recipe id, as returned by search_user_recipes.') },
    ['recipe_id'],
  ),
  filler: ['Let me pull that recipe up.', 'One moment, finding that recipe.'],
  async execute(args, ctx) {
    const recipe = await getRecipe(ctx.db, args.recipe_id);
    if (!recipe) throw new NotFoundError('Recipe');
    return {
      data: {
        ...summarize(recipe),
        steps: recipe.steps,
        is_favorite: recipe.isFavorite,
      },
    };
  },
});

export const searchUserRecipesTool = defineTool({
  name: 'search_user_recipes',
  description:
    "Search only the signed-in user's own saved recipes by title or ingredient. Use for 'my usual pasta', 'the one with the garlic butter', or to list what they have saved.",
  schema: z.object({ query: z.string().trim().max(200).default('') }),
  parameters: jsonSchema(
    { query: jsonSchema.string('Words from the title or an ingredient. Empty string lists recent recipes.') },
    [],
  ),
  filler: ['Let me check your recipes.', 'Looking through your recipes.'],
  async execute(args, ctx) {
    const recipes = args.query
      ? await searchRecipes(ctx.db, args.query, 5)
      : await listRecipes(ctx.db, 5);
    return { data: { count: recipes.length, recipes: recipes.map(summarize) } };
  },
});

export const getRecentCookingSessionsTool = defineTool({
  name: 'get_recent_cooking_sessions',
  description:
    "Look at how the signed-in user cooked recently: which recipe, how far they got, what they changed. Use for 'how did I make this last time' or 'what was I cooking yesterday'.",
  schema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  parameters: jsonSchema({ limit: jsonSchema.integer('How many sessions to return, 1 to 10.') }, []),
  filler: ['Let me look at what you cooked recently.', 'Checking your cooking history.'],
  async execute(args, ctx) {
    const sessions = await listSessions(ctx.db, args.limit);
    const titles = new Map<string, string>();

    for (const session of sessions) {
      if (session.recipeId && !titles.has(session.recipeId)) {
        const recipe = await getRecipe(ctx.db, session.recipeId);
        if (recipe) titles.set(session.recipeId, recipe.title);
      }
    }

    return {
      data: {
        sessions: sessions.map((session) => ({
          session_id: session.id,
          recipe_id: session.recipeId,
          title: session.recipeId ? (titles.get(session.recipeId) ?? 'Unknown recipe') : null,
          reached_step: session.currentStep + 1,
          status: session.status,
          servings: session.notes.servings ?? null,
          substitutions: (session.notes.substitutions ?? []).map((s) => `${s.from} to ${s.to}`),
          cooked_at: session.createdAt,
        })),
      },
    };
  },
});

export const scaleRecipeTool = defineTool({
  name: 'scale_recipe',
  description:
    'Recalculate ingredient quantities for a different number of servings. Also updates the current cooking session so later answers use the new amounts.',
  schema: z.object({
    recipe_id: z.string().uuid().optional(),
    servings: z.number().int().min(1).max(50),
  }),
  parameters: jsonSchema(
    {
      recipe_id: jsonSchema.string('Recipe to scale. Defaults to the recipe being cooked right now.'),
      servings: jsonSchema.integer('How many people the user is cooking for.'),
    },
    ['servings'],
  ),
  filler: ['Sure, let me recalculate that.', 'One moment, working that out.'],
  async execute(args, ctx) {
    const recipeId = args.recipe_id ?? ctx.state.session.recipeId;
    if (!recipeId) throw new NotFoundError('Recipe');

    const recipe = await getRecipe(ctx.db, recipeId);
    if (!recipe) throw new NotFoundError('Recipe');

    const scaled = scaleIngredients(recipe.ingredients, recipe.servings, args.servings);

    // Scaling the recipe the user is actually cooking is a state change, not
    // just a calculation: "how much cheese now?" must use the new numbers.
    let stateChanged = false;
    if (recipeId === ctx.state.session.recipeId) {
      await setServings(ctx.db, ctx.state, args.servings);
      stateChanged = true;
    }

    return {
      stateChanged,
      data: {
        title: recipe.title,
        from_servings: recipe.servings,
        to_servings: args.servings,
        ingredients: scaled.map(formatIngredient),
        applied_to_current_session: stateChanged,
      },
    };
  },
});

export const suggestSubstitutionTool = defineTool({
  name: 'suggest_substitution',
  description:
    "Find a replacement for an ingredient the user has run out of, with the correct ratio. Only returns curated swaps; if there is no entry, say so rather than inventing one.",
  schema: z.object({
    ingredient: z.string().trim().min(1).max(120),
    accept: z.boolean().default(false),
  }),
  parameters: jsonSchema(
    {
      ingredient: jsonSchema.string('The ingredient the user does not have.'),
      accept: {
        type: 'boolean',
        description:
          'Set true only when the user has agreed to use the first suggested replacement, so it is recorded in the cooking session.',
      },
    },
    ['ingredient'],
  ),
  filler: ['Let me think about what works instead.', 'One moment, checking a substitute.'],
  async execute(args, ctx) {
    const entry = findSubstitution(args.ingredient);
    if (!entry) {
      return {
        data: {
          ingredient: args.ingredient,
          found: false,
          note: 'No verified substitution on file. Tell the user you do not have a reliable swap for this one.',
        },
      };
    }

    let stateChanged = false;
    const first = entry.options[0];
    if (args.accept && first) {
      await recordSubstitution(ctx.db, ctx.state, {
        from: entry.ingredient,
        to: first.replacement,
        note: first.ratio,
      });
      stateChanged = true;
    }

    return {
      stateChanged,
      data: {
        ingredient: entry.ingredient,
        found: true,
        options: entry.options,
        recorded_in_session: stateChanged,
      },
    };
  },
});

export const saveRecipeTool = defineTool({
  name: 'save_recipe',
  description:
    "Save a new recipe to the signed-in user's own recipe box. Use when the user dictates a recipe or asks to keep one for next time.",
  schema: recipeInputSchema,
  parameters: jsonSchema(
    {
      title: jsonSchema.string('Short recipe name.'),
      servings: jsonSchema.integer('How many people it serves.'),
      ingredients: jsonSchema.array(
        jsonSchema(
          {
            name: jsonSchema.string('Ingredient name.'),
            quantity: jsonSchema.number('Amount, or null if it is to taste.'),
            unit: jsonSchema.string('Unit such as g, ml, tsp, cloves. Null if not applicable.'),
            note: jsonSchema.string('Preparation note, such as "finely chopped".'),
          },
          ['name'],
        ),
        'The ingredient list.',
      ),
      steps: jsonSchema.array(jsonSchema.string('One instruction.'), 'The method, in order.'),
    },
    ['title'],
  ),
  filler: ['Saving that for you.', 'One moment, writing that down.'],
  async execute(args, ctx) {
    const recipe = await createRecipe(ctx.db, { ...args, source: args.source ?? 'voice' });
    return { data: { saved: true, recipe_id: recipe.id, title: recipe.title } };
  },
});
