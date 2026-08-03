/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, branch-agnostic disposable-database guard.
//
// Enforces the same safety the P1 test-harness guard enforces (and works on main, which predates that
// guard): BOTH connection URLs must be set, and NEITHER may target the shared `king_ai_hub` database or any
// name/host that looks like staging/production/live/cloud. Prints database NAMES and HOSTS only — never the
// password or a full connection URL. On the P1 branches the repo's own `require-disposable-db` guard ALSO
// runs inside the suite (with REQUIRE_DISPOSABLE_DB=1); this is the belt-and-suspenders CI-native check.
const SHARED = 'king_ai_hub';
const FORBIDDEN_NAME = [/^king_ai_hub$/i, /stag/i, /prod/i, /\blive\b/i];
const ALLOWED_HOST = new Set(['localhost', '127.0.0.1', '::1', '']);

function dbName(u) {
  if (!u) return '';
  try {
    return (new URL(u).pathname.split('/').pop() ?? '').split('?')[0].trim();
  } catch {
    const noq = (u.split(/[?#]/)[0] ?? '');
    return (noq.split('/').pop() ?? '').trim();
  }
}
function dbHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

const fail = (msg) => {
  console.error(`[assert-disposable] REFUSING TO RUN: ${msg}`);
  process.exit(1);
};

const app = process.env.DATABASE_URL;
const mig = process.env.DATABASE_MIGRATION_URL;
if (!app || !app.trim()) fail('DATABASE_URL is unset/empty.');
if (!mig || !mig.trim()) fail('DATABASE_MIGRATION_URL is unset/empty (the fallback-to-shared bug).');

for (const [label, url] of [['DATABASE_URL', app], ['DATABASE_MIGRATION_URL', mig]]) {
  const name = dbName(url);
  const host = dbHost(url);
  if (!name) fail(`${label} has no database name.`);
  if (name === SHARED) fail(`${label} targets the shared '${SHARED}'.`);
  if (FORBIDDEN_NAME.some((r) => r.test(name))) fail(`${label} name '${name}' matches a forbidden shared/staging/production pattern.`);
  if (!ALLOWED_HOST.has(host)) fail(`${label} host '${host}' is not the ephemeral local service container.`);
  console.log(`[assert-disposable] OK ${label}: db='${name}' host='${host || 'localhost'}'`);
}

// Negative control: prove the pattern set actually rejects the shared name.
if (!FORBIDDEN_NAME.some((r) => r.test(SHARED))) fail(`self-test failed: shared name '${SHARED}' is not rejected by the pattern set.`);
console.log(`[assert-disposable] negative-control OK: '${SHARED}' (and staging/production names) are rejected.`);
