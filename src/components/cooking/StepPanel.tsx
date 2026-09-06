'use client';

import type { CookingStateSnapshot } from '@/lib/types';

export function StepPanel({ state }: { state: CookingStateSnapshot }) {
  return (
    <section className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          Step {Math.min(state.currentStep + 1, Math.max(state.totalSteps, 1))} of{' '}
          {state.totalSteps || 1}
        </h3>
        <span className="badge">
          {state.servings} {state.servings === 1 ? 'serving' : 'servings'}
          {state.servings !== state.baseServings ? ` (recipe: ${state.baseServings})` : ''}
        </span>
      </div>

      <p className="step">{state.currentStepText ?? 'No steps recorded for this recipe.'}</p>

      {state.nextStepText ? (
        <p className="muted small">Next: {state.nextStepText}</p>
      ) : (
        <p className="muted small">This is the last step.</p>
      )}
    </section>
  );
}
