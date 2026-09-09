'use client';

import { useSyncExternalStore } from 'react';

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, and the default is "system" — someone whose
 * laptop turns dark at sunset should not have to tell this app as well. A
 * choice is only stored once they actually make one.
 *
 * The attribute on `<html>` is set by a small script in the document head so
 * the page never paints light and then flips. That attribute, not React state,
 * is the source of truth here: this component subscribes to it rather than
 * keeping a second copy that could disagree with what is on screen.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'cooking-companion-theme';
const CHANGED = 'cooking-companion-theme-change';

function currentChoice(): ThemeChoice {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The server has no `<html>` to read, and no idea what the reader prefers. */
function serverChoice(): ThemeChoice {
  return 'system';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  // Another tab of the same app, changed while this one was open.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);

  try {
    if (choice === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private browsing, or storage disabled. The theme still applies to this
    // page; it just will not be remembered, which is not worth failing over.
  }

  window.dispatchEvent(new Event(CHANGED));
}

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, currentChoice, serverChoice);

  const label = choice === 'system' ? 'Theme: following the system' : `Theme: ${choice}`;

  return (
    <button
      type="button"
      className="ghost theme-toggle"
      onClick={() => apply(NEXT[choice])}
      title={`${label}. Click to change.`}
      aria-label={`${label}. Click to change.`}
    >
      {choice === 'dark' ? <MoonIcon /> : choice === 'light' ? <SunIcon /> : <SystemIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
