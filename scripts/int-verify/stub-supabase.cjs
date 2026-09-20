/**
 * Local stub of the Supabase GoTrue auth endpoint for ISOLATED integration tests.
 * Binds to 127.0.0.1 only. Validates exactly one test token and returns a fixed
 * synthetic user — so the app's `supabase.auth.getUser()` never contacts any
 * external Supabase project, and no real credentials or sessions are involved.
 * On SIGTERM it prints the full request log (evidence that only local /auth/v1/*
 * paths were hit).
 */
const http = require('node:http');

const OWNER_ID = process.env.STUB_USER_ID;
const OWNER_EMAIL = process.env.STUB_USER_EMAIL || 'owner@example.com';
const TOKEN = process.env.STUB_TOKEN;
const PORT = Number(process.env.STUB_PORT || 54999);
const requestLog = [];

function nowIso() {
  return new Date().toISOString();
}
function user() {
  return {
    id: OWNER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: OWNER_EMAIL,
    email_confirmed_at: nowIso(),
    phone: '',
    confirmed_at: nowIso(),
    last_sign_in_at: nowIso(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: nowIso(),
    updated_at: nowIso(),
    is_anonymous: false,
  };
}

const server = http.createServer((req, res) => {
  requestLog.push(`${req.method} ${req.url}`);
  const auth = req.headers['authorization'] || '';
  if (req.method === 'GET' && req.url.startsWith('/auth/v1/user')) {
    if (auth === `Bearer ${TOKEN}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(user()));
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 401, msg: 'invalid token' }));
    }
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/auth/v1/token')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: TOKEN,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'REFRESH',
          user: user(),
        }),
      );
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, '127.0.0.1', () => console.log(`STUB_READY 127.0.0.1:${PORT}`));
process.on('SIGTERM', () => {
  console.log('STUB_REQUEST_LOG ' + JSON.stringify(requestLog));
  server.close(() => process.exit(0));
});
