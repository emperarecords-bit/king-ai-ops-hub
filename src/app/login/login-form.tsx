'use client';

import { useActionState, useState } from 'react';
import { signIn, signUp, type AuthFormState } from './actions';

const initialState: AuthFormState = { error: null };

export function LoginForm() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [state, formAction, pending] = useActionState(
    mode === 'sign-in' ? signIn : signUp,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      {/* Segmented mode switch — sign-up must be discoverable at a glance,
          not a footnote (Sprint 3 M3 UX fix; the owner missed the old link). */}
      <div
        role="tablist"
        aria-label="Sign in or create account"
        className="grid grid-cols-2 rounded-md border border-[var(--border)] p-1"
      >
        {(
          [
            ['sign-in', 'Sign in'],
            ['sign-up', 'Create account'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={
              mode === value
                ? 'rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14]'
                : 'rounded px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="email" className="mb-1 block text-sm text-[var(--muted)]">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm text-[var(--muted)]">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] transition-colors hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
      </button>
    </form>
  );
}
