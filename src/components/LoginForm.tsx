'use client';

import { useActionState, useState } from 'react';
import { signIn, signUp, type AuthState } from '@/app/login/actions';

const INITIAL: AuthState = { error: null, message: null };

export function LoginForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [state, action, pending] = useActionState(mode === 'signin' ? signIn : signUp, INITIAL);

  return (
    <form action={action} className="stack">
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          minLength={8}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
        />
      </div>

      {state.error ? <div className="notice error">{state.error}</div> : null}
      {state.message ? <div className="notice">{state.message}</div> : null}

      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        className="ghost small"
        onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
      >
        {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
      </button>
    </form>
  );
}
