/**
 * Local stub of the Supabase GoTrue auth endpoint for ISOLATED integration tests.
 * Binds to 127.0.0.1 only. Validates exactly one synthetic access token and one
 * known refresh token; everything else is rejected. It records every request
 * (method, url, whether a valid token was presented, response status) in memory
 * and to STUB_LOG_FILE, and exposes them at GET /debug/requests — so a test can
 * assert the stub actually RECEIVED and REJECTED an invalid token. The app's
 * `supabase.auth.getUser()` therefore never contacts any external Supabase
 * project, and no real credentials or sessions are involved.
 */
const http = require('node:http');
const fs = require('node:fs');

const OWNER_ID = process.env.STUB_USER_ID;
const OWNER_EMAIL = process.env.STUB_USER_EMAIL || 'owner@example.com';
const TOKEN = process.env.STUB_TOKEN; // the primary valid access token
// One OR MORE valid access tokens. Each is a structural JWT whose `sub`/`email` claims identify the
// user it authenticates — so a test can present a second user's token to exercise a non-member path.
// Backward compatible: with only STUB_TOKEN set this is exactly the single-token behaviour.
const VALID_TOKENS = new Set((process.env.STUB_TOKENS || TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean));
const REFRESH = process.env.STUB_REFRESH || 'REFRESH'; // the one known refresh token

/** Decode the `sub`/`email` claims of a JWT-shaped token (no signature check — this is a local stub). */
function claimsOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { id: typeof payload.sub === 'string' ? payload.sub : OWNER_ID, email: typeof payload.email === 'string' ? payload.email : OWNER_EMAIL };
  } catch {
    return { id: OWNER_ID, email: OWNER_EMAIL };
  }
}
const PORT = Number(process.env.STUB_PORT || 54999);
const LOG_FILE = process.env.STUB_LOG_FILE || '';
const requestLog = [];

function record(entry) {
  requestLog.push(entry);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch {
      /* best effort */
    }
  }
}
function nowIso() {
  return new Date().toISOString();
}
function user(id = OWNER_ID, email = OWNER_EMAIL) {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
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
  const auth = req.headers['authorization'] || '';
  const tokenPresented = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const tokenValid = tokenPresented !== null && VALID_TOKENS.has(tokenPresented);

  // Debug: the recorded request log (loopback only).
  if (req.method === 'GET' && req.url.startsWith('/debug/requests')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requestLog));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/auth/v1/user')) {
    const status = tokenValid ? 200 : 401;
    record({ t: nowIso(), method: 'GET', url: '/auth/v1/user', tokenPresented: tokenPresented !== null, tokenValid, status });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(tokenValid ? JSON.stringify(user(...Object.values(claimsOf(tokenPresented)))) : JSON.stringify({ code: 401, msg: 'invalid token' }));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/auth/v1/token')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let refresh = null;
      try {
        refresh = new URLSearchParams(body).get('refresh_token') ?? JSON.parse(body || '{}').refresh_token ?? null;
      } catch {
        refresh = null;
      }
      // Reject UNKNOWN refresh tokens — only the one known refresh is honored.
      const ok = refresh === REFRESH;
      const status = ok ? 200 : 401;
      record({ t: nowIso(), method: 'POST', url: '/auth/v1/token', refreshKnown: ok, status });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        ok
          ? JSON.stringify({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: REFRESH, user: user() })
          : JSON.stringify({ code: 401, error: 'invalid_grant', msg: 'unknown refresh token' }),
      );
    });
    return;
  }

  record({ t: nowIso(), method: req.method, url: req.url, status: 404 });
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, '127.0.0.1', () => console.log(`STUB_READY 127.0.0.1:${PORT}`));
process.on('SIGTERM', () => {
  console.log('STUB_REQUEST_LOG ' + JSON.stringify(requestLog));
  server.close(() => process.exit(0));
});
