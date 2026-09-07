'use client';

import type { CookingStateSnapshot } from '@/lib/types';

export function StepPanel({ state }: { state: CookingStateSnapshot }) {
  // Before a dish is chosen the screen has one job: make it obvious you can
  // just say what you want. Showing "Step 1 of 1" of an empty recipe would be
  // both wrong and discouraging.
  if (state.awaitingRecipe) {
    return (
      <section className="card">
        <h3 style={{ margin: 0 }}>Nothing on the go</h3>
        <p className="step" style={{ marginBottom: 8 }}>
          Say what you feel like making.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          &ldquo;I want to make pasta for three.&rdquo; &nbsp;·&nbsp; &ldquo;Something with chicken
          and rice.&rdquo; Mention anything you&rsquo;re out of and it will work around it.
        </p>
      </section>
    );
  }

  const passive = state.currentStepDetail?.attention === 'passive';

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

      {passive ? (
        <p className="muted small" style={{ marginTop: -4 }}>
          This one runs by itself — you&rsquo;ll be told when it&rsquo;s ready.
        </p>
      ) : null}

      {state.nextStepText ? (
        <p className="muted small">Next: {state.nextStepText}</p>
      ) : (
        <p className="muted small">This is the last step.</p>
      )}
    </section>
  );
}
