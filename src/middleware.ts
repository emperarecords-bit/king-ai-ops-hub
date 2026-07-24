import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Session refresh only. Authorization decisions live in requireTenant() at the
 * data boundary — middleware is a UX nicety (redirect anonymous users to
 * /login), never a security control.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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
        response = NextResponse.next({ request });
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
  const isPublic = pathname === '/login' || pathname.startsWith('/auth');

  if (!user && !isPublic) {
    // API callers get a JSON 401 (a login-page redirect would arrive as a 200
    // HTML body to a fetch() and mask the real condition). Route handlers
    // still run requireTenant — this is presentation, not the security gate.
    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not signed in.' }, { status: 401 });
    }
    const redirect = request.nextUrl.clone();
    redirect.pathname = '/login';
    redirect.search = '';
    return NextResponse.redirect(redirect);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
