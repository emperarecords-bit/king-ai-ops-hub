/**
 * Mints @supabase/ssr session cookie(s) the app server will read, driving the real
 * createServerClient cookie storage against the LOCAL stub. Emits:
 *   COOKIE_VALID   <header>   — a session for the valid synthetic token
 *   COOKIE_INVALID <header>   — the SAME real SSR cookie format, but its
 *                               access_token replaced with a synthetic INVALID
 *                               token the stub rejects (for the auth-rejection test)
 *
 * Local-destination validation is enforced HERE, before any request: SUPABASE_URL
 * must be loopback, and the client's fetch is wrapped to re-assert loopback and to
 * disable redirects on every call.
 */
const { createServerClient } = require('@supabase/ssr');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
function assertLoopback(u) {
  const host = new URL(u).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`refusing non-loopback auth URL: ${u}`);
}

function jwt(sub) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) }),
  ).toString('base64url');
  return `${h}.${p}.invalidsig`;
}

function reencodeWithToken(value, newToken) {
  if (!value.startsWith('base64-')) throw new Error('unexpected @supabase/ssr cookie format');
  const session = JSON.parse(Buffer.from(value.slice(7), 'base64').toString('utf8'));
  session.access_token = newToken; // keep the exact real cookie shape; only swap the token
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const token = process.env.STUB_TOKEN;
  if (!url || !anon || !token) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY, STUB_TOKEN required');
  assertLoopback(url); // before any request

  const guardedFetch = (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    assertLoopback(target); // re-assert on every request
    return fetch(target, { ...init, redirect: 'error' }); // redirects disabled
  };

  const jar = {};
  const client = createServerClient(url, anon, {
    global: { fetch: guardedFetch },
    cookies: {
      getAll() {
        return Object.entries(jar).map(([name, value]) => ({ name, value }));
      },
      setAll(list) {
        for (const { name, value } of list) jar[name] = value;
      },
    },
  });

  const { error } = await client.auth.setSession({ access_token: token, refresh_token: process.env.STUB_REFRESH || 'REFRESH' });
  if (error) {
    console.error('SETSESSION_ERR ' + error.message);
    process.exit(1);
  }

  const invalidToken = jwt('00000000-0000-0000-0000-000000000000');
  const validHeader = Object.entries(jar)
    .map(([n, v]) => `${n}=${v}`)
    .join('; ');
  const invalidHeader = Object.entries(jar)
    .map(([n, v]) => `${n}=${reencodeWithToken(v, invalidToken)}`)
    .join('; ');

  console.log('COOKIE_VALID ' + validHeader);
  console.log('COOKIE_INVALID ' + invalidHeader);
}

main().catch((e) => {
  console.error('MINT_ERR ' + (e && e.message));
  process.exit(1);
});
