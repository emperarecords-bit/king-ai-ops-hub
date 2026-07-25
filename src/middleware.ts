import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Session refresh and CSP. Authorization decisions live in requireTenant() at
 * the data boundary — middleware is a UX nicety (redirect anonymous users to
 * /login), never a security control.
 *
 * CSP (Sprint 10, closing the deployment blocker): production gets a
 * per-request nonce, so Next's hydration bootstrap runs while arbitrary
 * injected script does not. Development keeps 'unsafe-inline'/'unsafe-eval'
 * because HMR needs eval and the dev overlay injects unnonced script — the
 * shipped artifact is what must be strict.
 */
function buildCsp(nonce: string, isDev: boolean): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : // strict-dynamic lets nonced Next bootstrap load its own chunks;
      // browsers honoring it ignore the 'self' fallback, which is retained
      // only for older engines.
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

export async function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== 'production';
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, isDev);

  // Next reads x-nonce off the REQUEST to nonce its own inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // Rebuild with the SAME modified request headers, or the nonce and
        // CSP are silently dropped on any request that refreshes a session.
        response = NextResponse.next({ request: { headers: requestHeaders } });
        response.headers.set('content-security-policy', csp);
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refreshes the token if expired; the RESULT is not used for authorization.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // /api/health is an unauthenticated liveness probe for the load balancer
  // (O-21) — it exposes only aggregate up/down, never tenant data.
  const isPublic =
    pathname === '/login' || pathname.startsWith('/auth') || pathname === '/api/health';

  if (!user && !isPublic) {
    // API callers get a JSON 401 (a login-page redirect would arrive as a 200
    // HTML body to a fetch() and mask the real condition). Route handlers
    // still run requireTenant — this is presentation, not the security gate.
    if (pathname.startsWith('/api/')) {
      return Response.json(
        { error: 'Not signed in.' },
        { status: 401, headers: { 'content-security-policy': csp } },
      );
    }
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/login';
    redirect.search = '';
    const redirectResponse = NextResponse.redirect(redirect);
    redirectResponse.headers.set('content-security-policy', csp);
    return redirectResponse;
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
