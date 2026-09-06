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

      <div className="grid two">
        <section className="card">
          <h3>Your recipes</h3>
          {recipes.length === 0 ? (
            <p className="muted">
              No recipes yet. Start a session and dictate one — the assistant can save it for you.
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
                  <StartCookingButton recipeId={recipe.id} />
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
