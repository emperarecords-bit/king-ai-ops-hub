/**
 * TEST-HARNESS GUARD (tests-only) — refuse DB-backed P1a verification against the SHARED database.
 *
 * Background / the incident this prevents: the P1a DB-backed suites resolve their connection from
 * `DATABASE_URL` (app_server, via getSetupDb → actually DATABASE_MIGRATION_URL) and
 * `DATABASE_MIGRATION_URL` (migration role). When `DATABASE_MIGRATION_URL` was left UNSET, `getSetupDb()`
 * silently fell back to the shared `king_ai_hub` database and a "verification" run mutated shared data.
 *
 * This guard makes that impossible when a verification run OPTS IN via `REQUIRE_DISPOSABLE_DB=1`:
 *   - BOTH `DATABASE_URL` and `DATABASE_MIGRATION_URL` must be set/non-empty (an unset MIGRATION url is the
 *     exact fallback bug), and
 *   - NEITHER url's database name may be exactly `king_ai_hub` (the shared DB).
 * Disposable verification databases are named `king_ai_hub_p1a_verify*` — they CONTAIN the shared name as a
 * prefix, so the check compares the parsed database name for EXACT equality, never a substring.
 *
 * By repo convention, ordinary `npm test` runs against the shared `king_ai_hub` and does NOT set the flag —
 * so this guard is a strict no-op there and the default suite is unchanged.
 */

/** The one database name that DB-backed P1a verification must never touch. */
export const SHARED_DB_NAME = 'king_ai_hub';

/** The opt-in flag. Only when this is exactly '1' does the guard enforce anything. */
export function disposableDbRequired(): boolean {
  return process.env.REQUIRE_DISPOSABLE_DB === '1';
}

/**
 * Parse the database name from a postgres connection string: the LAST path segment, with any query string
 * (`?sslmode=...`) stripped. Returns '' when no database name is present. Never throws on a malformed URL —
 * it falls back to a manual parse so a bad url is reported by the guard as "unset/empty", not as a crash.
 */
export function parseDbName(url: string | undefined | null): string {
  if (!url) return '';
  const strip = (s: string): string => {
    const seg = s.split('/').pop() ?? '';
    return (seg.split('?')[0] ?? '').trim();
  };
  try {
    return strip(new URL(url).pathname);
  } catch {
    // Not a WHATWG-parseable URL — parse the path portion manually (drop query/hash first).
    const noQuery = url.split(/[?#]/)[0] ?? '';
    return strip(noQuery);
  }
}

/**
 * When `REQUIRE_DISPOSABLE_DB=1`, throw a clear error if either connection url is unset/empty OR points at the
 * shared `king_ai_hub` database. No-op otherwise. Invoke at DB-connection setup (before any connection opens)
 * and from module-init/beforeAll in the DB-backed P1a verification suites.
 *
 * @param label short caller tag included in the thrown message (e.g. 'agent-pinning.test').
 */
export function assertDisposableDbForVerification(label = 'p1a-verification'): void {
  if (!disposableDbRequired()) return; // opt-in only — default dev suite is unchanged.

  const appUrlRaw = process.env.DATABASE_URL;
  const migUrlRaw = process.env.DATABASE_MIGRATION_URL;

  const fail = (msg: string): never => {
    throw new Error(
      `[${label}] REQUIRE_DISPOSABLE_DB=1 refuses to run: ${msg} ` +
        `DB-backed P1a verification must target a DISPOSABLE database (e.g. king_ai_hub_p1a_verify3), ` +
        `never the shared '${SHARED_DB_NAME}'. Set BOTH DATABASE_URL and DATABASE_MIGRATION_URL to the ` +
        `disposable DB. (DATABASE_URL db='${parseDbName(appUrlRaw) || '<unset>'}', ` +
        `DATABASE_MIGRATION_URL db='${parseDbName(migUrlRaw) || '<unset>'}')`,
    );
  };

  // 1) Both urls must be set/non-empty. An unset DATABASE_MIGRATION_URL is the exact fallback bug.
  if (!appUrlRaw || appUrlRaw.trim() === '') fail('DATABASE_URL is unset/empty.');
  if (!migUrlRaw || migUrlRaw.trim() === '') fail('DATABASE_MIGRATION_URL is unset/empty (the fallback-to-shared bug).');

  // 2) Neither database name may be exactly the shared DB. Exact match — disposable DBs merely share the prefix.
  const appDb = parseDbName(appUrlRaw);
  const migDb = parseDbName(migUrlRaw);
  if (appDb === '') fail('DATABASE_URL has no database name.');
  if (migDb === '') fail('DATABASE_MIGRATION_URL has no database name.');
  if (appDb === SHARED_DB_NAME) fail(`DATABASE_URL targets the shared '${SHARED_DB_NAME}'.`);
  if (migDb === SHARED_DB_NAME) fail(`DATABASE_MIGRATION_URL targets the shared '${SHARED_DB_NAME}'.`);
}
