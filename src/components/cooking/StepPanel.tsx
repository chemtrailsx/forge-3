'use client';

import type { CookingStateSnapshot } from '@/lib/types';

export function StepPanel({ state }: { state: CookingStateSnapshot }) {
  if (state.awaitingRecipe) {
    return (
      <div className="step-container">
        <div className="spread" style={{ marginBottom: 12 }}>
          <span className="badge on">Ready to Cook</span>
        </div>
        <h2 className="step-instruction" style={{ marginBottom: 8, fontSize: '1.5rem' }}>
          What are you making today?
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: '0.92rem', lineHeight: 1.6 }}>
          Say what you feel like cooking &mdash; e.g. &ldquo;I want to make white sauce pasta for two&rdquo; or mention whatever ingredients you have in your kitchen.
        </p>
      </div>
    );
  }

  const currentStepNum = Math.min(state.currentStep + 1, Math.max(state.totalSteps, 1));
  const totalStepsNum = state.totalSteps || 1;
  const progressPercent = Math.round((currentStepNum / totalStepsNum) * 100);
  const passive = state.currentStepDetail?.attention === 'passive';

  return (
    <div className="step-container">
      <div className="spread">
        <div>
          <div className="section-label">Active Step</div>
          <h3 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)', textTransform: 'none' }}>
            Step {currentStepNum} of {totalStepsNum}
          </h3>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {passive ? (
            <span
              className="badge"
              style={{
                borderColor: 'var(--warn)',
                background: 'var(--warn-quiet)',
                color: 'var(--warn)',
              }}
            >
              Timed step
            </span>
          ) : null}
          <span className="badge servings">
            {state.servings} {state.servings === 1 ? 'serving' : 'servings'}
            {state.servings !== state.baseServings ? ` (base: ${state.baseServings})` : ''}
          </span>
        </div>
      </div>

      <div className="step-progress-track">
        <div className="step-progress-indicator" style={{ width: `${progressPercent}%` }} />
      </div>

      <div className="step-instruction">
        {state.currentStepText ?? 'No steps recorded for this recipe.'}
      </div>

      {passive ? (
        <p className="small" style={{ marginBottom: 14, color: 'var(--warn)', fontWeight: 500 }}>
          This step runs by itself &mdash; your assistant will notify you when it finishes.
        </p>
      ) : null}

      {state.nextStepText ? (
        <div className="next-step-badge">
          <strong>Next</strong>
          <span>{state.nextStepText}</span>
        </div>
      ) : (
        <div className="next-step-badge">
          <strong>Done</strong>
          <span>This is the final step of the recipe. Enjoy!</span>
        </div>
      )}
    </div>
  );
}
