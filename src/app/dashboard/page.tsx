import Link from 'next/link';
import { redirect } from 'next/navigation';
import { StartCookingButton } from '@/components/StartCookingButton';
import { TopBar } from '@/components/TopBar';
import { getUserContext } from '@/lib/auth/session';
import { formatIngredient } from '@/lib/cooking/scale';
import { dbFor } from '@/lib/db/context';
import { getRecipe, listRecipes } from '@/lib/db/recipes';
import { listSessions } from '@/lib/db/sessions';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');

  const db = dbFor(ctx);
  const [recipes, sessions] = await Promise.all([listRecipes(db, 20), listSessions(db, 6)]);

  // Titles for the "resume" list. Small N, one user, one round trip each.
  const titles = new Map<string, string>();
  for (const session of sessions) {
    if (session.recipeId && !titles.has(session.recipeId)) {
      const recipe = await getRecipe(db, session.recipeId);
      if (recipe) titles.set(session.recipeId, recipe.title);
    }
  }

  const resumable = sessions.filter((session) => session.status !== 'finished');

  return (
    <main className="page">
      <TopBar email={ctx.email} current="cook" />

      {/*
        The main way in. You do not pick a recipe first — you start talking and
        say what you feel like making, and the assistant writes the recipe
        around what you have. The saved list below is for coming back to
        something, not the price of entry.
      */}
      <section className="card" style={{ marginBottom: 18 }}>
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>What are you making?</h2>
            <p className="muted small" style={{ margin: 0, maxWidth: 460 }}>
              Start a session and just say it — &ldquo;I want to make pasta for three&rdquo;. Tell it
              what you have and what you don&rsquo;t, and it will work around you. It keeps track of
              anything left on the heat and tells you when to come back.
            </p>
          </div>
          <StartCookingButton label="Start cooking" />
        </div>
      </section>

      <div className="grid two">
        <section className="card">
          <h3>Your recipes</h3>
          {recipes.length === 0 ? (
            <p className="muted small">
              Nothing saved yet. Anything you cook can be kept for next time — just ask.
            </p>
          ) : (
            <ul className="plain">
              {recipes.map((recipe) => (
                <li key={recipe.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="spread">
                    <strong>{recipe.title}</strong>
                    <span className="muted small">
                      serves {recipe.servings} · {recipe.steps.length} steps
                    </span>
                  </div>
                  <p className="muted small" style={{ margin: '4px 0 8px' }}>
                    {recipe.ingredients.slice(0, 4).map(formatIngredient).join(', ')}
                    {recipe.ingredients.length > 4 ? '…' : ''}
                  </p>
                  <StartCookingButton recipeId={recipe.id} label="Cook this" variant="plain" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>Recent cooking</h3>
          {resumable.length === 0 ? (
            <p className="muted">Nothing in progress.</p>
          ) : (
            <ul className="plain">
              {resumable.map((session) => (
                <li key={session.id}>
                  <div>
                    <div>
                      <strong>
                        {session.recipeId ? (titles.get(session.recipeId) ?? 'Recipe') : 'Session'}
                      </strong>
                    </div>
                    <span className="muted small">
                      step {session.currentStep + 1}
                      {session.notes.servings ? ` · for ${session.notes.servings}` : ''} ·{' '}
                      {new Date(session.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Link className="button" href={`/cook/${session.id}`}>
                    Resume
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
