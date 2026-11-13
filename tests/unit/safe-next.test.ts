import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANDING, safeNext } from '@/lib/safe-next';

/**
 * Post-login destination validation.
 *
 * Owner report 2026-11-13: the installed PWA always opened the dashboard, ignoring the manifest's
 * `start_url: /ops`. Cause was not the manifest — middleware threw the requested path away and
 * login hardcoded `/projects`. Carrying a destination through sign-in fixes that, but a redirect
 * target taken from the URL is an open-redirect primitive, so the validation below is the load-
 * bearing part of the fix and these cases must never soften.
 */

describe('safeNext — allows only same-origin absolute paths', () => {
  it('passes real in-app destinations through untouched', () => {
    for (const p of ['/ops', '/inbox', '/projects', '/p/empera/agents', '/ops?tab=chat', '/a/b/c#frag']) {
      expect(safeNext(p)).toBe(p);
    }
  });

  it('falls back to the chat-first default when there is nothing usable', () => {
    expect(DEFAULT_LANDING).toBe('/ops');
    for (const p of [undefined, null, '', 42, {}, [] as unknown]) {
      expect(safeNext(p)).toBe('/ops');
    }
  });

  it('REFUSES off-origin targets — the open-redirect phishing primitive', () => {
    for (const p of [
      'https://evil.example/pwned',
      'http://evil.example',
      '//evil.example',               // protocol-relative
      // Backslash form some engines normalize to "//". Built by code point: written as a literal
      // escape it is trivially corrupted into the harmless path "/evil.example", which passes
      // validation and would make this assertion silently test nothing.
      `/${String.fromCharCode(92)}evil.example`,
      'javascript:alert(1)',
      'data:text/html,<script>',
      'evil.example/path',            // no leading slash
    ]) {
      expect(safeNext(p), `must refuse ${p}`).toBe('/ops');
    }
  });

  it('REFUSES control characters (CR/LF header smuggling)', () => {
    expect(safeNext('/ops\r\nLocation: https://evil.example')).toBe('/ops');
    expect(safeNext('/ops\u0000')).toBe('/ops');
  });

  it('REFUSES the auth pages themselves, so sign-in cannot loop', () => {
    for (const p of ['/login', '/login?next=/login', '/login/x', '/auth', '/auth/callback']) {
      expect(safeNext(p)).toBe('/ops');
    }
  });

  it('refuses absurdly long values', () => {
    expect(safeNext('/' + 'a'.repeat(512))).toBe('/ops');
  });

  it('honours an explicit fallback (middleware passes "" to mean "do not set next")', () => {
    expect(safeNext('https://evil.example', '')).toBe('');
    expect(safeNext('/ops', '')).toBe('/ops');
  });
});

describe('the login chain actually uses it — no hardcoded landing survives', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('middleware preserves the requested path as ?next instead of discarding it', () => {
    const mw = read('src/middleware.ts');
    expect(mw).toMatch(/safeNext/);
    expect(mw).toMatch(/redirect\.searchParams\.set\('next', wanted\)/);
  });

  it('sign-in and sign-up redirect via safeNext, never to a literal page', () => {
    const actions = read('src/app/login/actions.ts');
    expect(actions).toMatch(/redirect\(safeNext\(formData\.get\('next'\)\)\)/);
    // signOut legitimately goes to /login; nothing else may hardcode a destination.
    expect(actions).not.toMatch(/redirect\('\/projects'\)/);
  });

  it('the login page forwards the validated destination into the form', () => {
    expect(read('src/app/login/page.tsx')).toMatch(/<LoginForm next=\{next\} \/>/);
    expect(read('src/app/login/login-form.tsx')).toMatch(/name="next"/);
  });
});
