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

      {/* Hero card */}
      <section
        className="card"
        style={{
          marginBottom: 24,
          background: 'linear-gradient(135deg, #FFFFFF 0%, #FAF6F0 100%)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-md)',
          padding: '32px 32px',
          borderRadius: 'var(--radius-xl)',
        }}
      >
        <div className="spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 20 }}>
          <div style={{ maxWidth: 560 }}>
            <div className="badge on" style={{ marginBottom: 12 }}>
              Voice-First Kitchen Studio
            </div>
            <h2 style={{ fontSize: '1.75rem', marginBottom: 8, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              What are you cooking today?
            </h2>
            <p className="muted" style={{ margin: 0, fontSize: '0.94rem', lineHeight: 1.6 }}>
              Start a hands-free voice session &mdash; describe ingredients you have,
              get intelligent step-by-step guidance, and manage active timers on the fly.
            </p>
          </div>
          <div>
            <StartCookingButton label="Start New Session" />
          </div>
        </div>
      </section>

      <div className="grid two">
        <section className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div className="section-label">Cookbook</div>
              <h3 style={{ margin: 0 }}>Saved Recipes</h3>
            </div>
            <span className="badge">{recipes.length} total</span>
          </div>

          {recipes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-tertiary)' }}>
              <p className="small" style={{ margin: 0 }}>
                No recipes saved yet.
              </p>
              <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
                Anything you cook can be saved for future sessions &mdash; just ask your companion.
              </p>
            </div>
          ) : (
            <ul className="plain">
              {recipes.map((recipe) => (
                <li key={recipe.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: '14px 16px' }}>
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>{recipe.title}</strong>
                    <span className="badge" style={{ fontSize: '0.72rem' }}>
                      serves {recipe.servings} &middot; {recipe.steps.length} steps
                    </span>
                  </div>
                  <p className="muted small" style={{ margin: 0, lineHeight: 1.4 }}>
                    {recipe.ingredients.slice(0, 4).map(formatIngredient).join(', ')}
                    {recipe.ingredients.length > 4 ? '…' : ''}
                  </p>
                  <div style={{ marginTop: 4 }}>
                    <StartCookingButton recipeId={recipe.id} label="Cook this recipe" variant="plain" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div className="section-label">History</div>
              <h3 style={{ margin: 0 }}>Recent Cooking</h3>
            </div>
            <span className="badge">{resumable.length} active</span>
          </div>

          {resumable.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-tertiary)' }}>
              <p className="small" style={{ margin: 0 }}>
                No active cooking sessions.
              </p>
              <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
                Start a session to begin your culinary journey.
              </p>
            </div>
          ) : (
            <ul className="plain">
              {resumable.map((session) => (
                <li key={session.id} style={{ padding: '14px 16px' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                      {session.recipeId ? (titles.get(session.recipeId) ?? 'Recipe') : 'Open Session'}
                    </div>
                    <span className="muted small">
                      Step {session.currentStep + 1}
                      {session.notes.servings ? ` · for ${session.notes.servings}` : ''} &middot;{' '}
                      {new Date(session.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Link className="button" href={`/cook/${session.id}`} style={{ padding: '6px 14px', fontSize: '0.82rem' }}>
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
