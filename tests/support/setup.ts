/**
 * Vitest global setup. Provides a minimal env so modules with lazy env
 * validation can be imported; tests that need real values override locally.
 */
import { assertDisposableDbForVerification } from './require-disposable-db';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

// DB-connection setup guard. When a verification run opts in via REQUIRE_DISPOSABLE_DB=1, refuse to run the
// whole suite unless BOTH DATABASE_URL and DATABASE_MIGRATION_URL are set to a DISPOSABLE database (never the
// shared `king_ai_hub`). This runs in each test worker BEFORE that worker's test module opens any connection,
// so it trips before the shared DB can ever be touched. A strict no-op when the flag is unset — the default
// `npm test` run (which by repo convention uses the shared DB) is unchanged.
assertDisposableDbForVerification('vitest-setup');
