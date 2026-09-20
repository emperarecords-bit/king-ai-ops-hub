/**
 * Mints the exact @supabase/ssr session cookie(s) the app server will read, by
 * driving the real `createServerClient` cookie storage against the LOCAL stub.
 * Prints `COOKIE <header>` for the integration test to send. No external calls:
 * SUPABASE_URL points at the 127.0.0.1 stub.
 */
const { createServerClient } = require('@supabase/ssr');

async function main() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const token = process.env.STUB_TOKEN;
  if (!url || !anon || !token) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY, STUB_TOKEN required');

  const jar = {};
  const client = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return Object.entries(jar).map(([name, value]) => ({ name, value }));
      },
      setAll(list) {
        for (const { name, value } of list) jar[name] = value;
      },
    },
  });

  const { error } = await client.auth.setSession({ access_token: token, refresh_token: 'REFRESH' });
  if (error) {
    console.error('SETSESSION_ERR ' + error.message);
    process.exit(1);
  }
  const cookie = Object.entries(jar)
    .map(([n, v]) => `${n}=${v}`)
    .join('; ');
  console.log('COOKIE ' + cookie);
}

main().catch((e) => {
  console.error('MINT_ERR ' + (e && e.message));
  process.exit(1);
});
