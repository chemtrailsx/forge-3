'use client';

import { formatIngredient } from '@/lib/cooking/scale';
import type { CookingStateSnapshot } from '@/lib/types';

export function IngredientPanel({ state }: { state: CookingStateSnapshot }) {
  if (state.awaitingRecipe) {
    return (
      <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-3)' }}>
        <p className="small" style={{ margin: 0, fontWeight: 500 }}>
          No recipe selected yet
        </p>
        <p className="muted small" style={{ marginTop: 4 }}>
          Ingredients will populate once you choose what to make.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="section-label">Recipe Essentials</div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)', textTransform: 'none' }}>
            Ingredients
          </h3>
        </div>
        <span className="badge">
          {state.ingredients.length} items
        </span>
      </div>

      <ul className="plain">
        {state.ingredients.map((ingredient, index) => (
          <li key={`${ingredient.name}-${index}`} className="ingredient-item">
            <div className="row" style={{ gap: 10 }}>
              <span className="ingredient-bullet" />
              <span style={{ fontWeight: 500 }}>{formatIngredient(ingredient)}</span>
            </div>
          </li>
        ))}
        {state.ingredients.length === 0 ? (
          <li className="muted small">None recorded for this recipe.</li>
        ) : null}
      </ul>

      {state.substitutions.length > 0 ? (
        <div style={{ marginTop: 24 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>Suggested Alternatives</div>
          <ul className="plain">
            {state.substitutions.map((substitution) => (
              <li key={substitution.from} className="ingredient-item">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div className="row" style={{ gap: 6, fontSize: '0.9rem' }}>
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-3)' }}>
                      {substitution.from}
                    </span>
                    <span style={{ color: 'var(--accent)' }}>&rarr;</span>
                    <span style={{ fontWeight: 600 }}>{substitution.to}</span>
                  </div>
                  {substitution.note ? (
                    <span className="muted small">{substitution.note}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
