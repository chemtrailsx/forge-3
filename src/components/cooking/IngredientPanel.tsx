'use client';

import { formatIngredient } from '@/lib/cooking/scale';
import type { CookingStateSnapshot } from '@/lib/types';

export function IngredientPanel({ state }: { state: CookingStateSnapshot }) {
  return (
    <section className="card">
      <h3>Ingredients</h3>
      <ul className="plain">
        {state.ingredients.map((ingredient, index) => (
          <li key={`${ingredient.name}-${index}`}>
            <span>{formatIngredient(ingredient)}</span>
          </li>
        ))}
        {state.ingredients.length === 0 ? <li className="muted">None recorded.</li> : null}
      </ul>

      {state.substitutions.length > 0 ? (
        <>
          <h3 style={{ marginTop: 16 }}>Substitutions</h3>
          <ul className="plain">
            {state.substitutions.map((substitution) => (
              <li key={substitution.from}>
                <span>
                  {substitution.from} → {substitution.to}
                </span>
                <span className="muted small">{substitution.note}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
