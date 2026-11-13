/**
 * Where a signed-in owner lands when nothing better is known.
 *
 * Chat-first front door (owner direction 2026-09-15), matching `src/app/page.tsx`. The login path
 * used to hardcode `/projects`, which silently defeated the PWA's `start_url` — see safeNext below.
 */
export const DEFAULT_LANDING = '/ops';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Built by code point so no editor, shell heredoc, or copy-paste can silently eat the escape. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Validate a post-login `next` destination, failing closed to {@link DEFAULT_LANDING}.
 *
 * Only a SAME-ORIGIN, absolute-path destination is allowed. Everything else falls back:
 *   - an absolute URL (`https://evil.example`) or any scheme, including `javascript:`;
 *   - a protocol-relative `//evil.example`, and the `/\evil.example` form that some engines
 *     normalize to `//` — both would navigate off-origin while looking like a path;
 *   - control characters, which can smuggle CR/LF into a Location header;
 *   - `/login` and `/auth`, which would bounce the owner straight back into a redirect loop.
 *
 * Echoing a caller-supplied URL out of a login redirect is the classic open-redirect phishing
 * primitive: an attacker sends `…/login?next=https://lookalike`, the victim authenticates against
 * the REAL site, and is then handed to the attacker's page already trusting it. So this validates
 * and discards rather than trying to sanitize — there is no partial credit on a redirect target.
 */
export function safeNext(next: unknown, fallback: string = DEFAULT_LANDING): string {
  if (typeof next !== 'string') return fallback;
  if (next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith(`/${BACKSLASH}`)) return fallback;
  if (CONTROL_CHARS.test(next)) return fallback;
  if (next === '/login' || next.startsWith('/login/') || next.startsWith('/login?')) return fallback;
  if (next === '/auth' || next.startsWith('/auth/') || next.startsWith('/auth?')) return fallback;
  return next;
}
