/**
 * Issue #117 — scoped, bounded timeouts for the DB / git-heavy test files.
 *
 * A specific family of G-Backup + bootstrap test files legitimately does expensive work per test: creating a fresh
 * disposable Postgres database and running the FULL migration set + RLS (bootstrap), or shelling out to `git` many
 * times to read committed migration/source blobs (`git show` / `git cat-file`, `deriveMigrationFacts`,
 * `buildSourceManifestFromGit`, `makeIdentityMigrationsFolder`). In ISOLATION each such test runs ~2–5 s; under the
 * full parallel suite (one worker per core) CPU + process-spawn + Postgres contention pushes them past vitest's
 * 5000 ms per-test default, producing run-to-run "Test timed out in 5000ms" flakiness. Measured: even with only the
 * heavy family running together, individual tests reached ~9.8 s.
 *
 * Applying these bounds to ONLY the heavy files raises their per-test timeout to a bounded 30 s (hooks 60 s) so the
 * tests can finish under contention. It changes NO assertion, NO DB isolation/cleanup, NO migration coverage, and
 * NO production behavior; the ~220 fast unit tests keep the 5000 ms default. This is an explicit headroom bound for
 * expensive fresh-DB / git-blob integration work, not a generic escape hatch. Usage (once, at module top level):
 *
 *   import { vi } from 'vitest';
 *   import { HEAVY_TEST_TIMEOUT_MS, HEAVY_HOOK_TIMEOUT_MS } from '../support/heavy-timeout';
 *   vi.setConfig({ testTimeout: HEAVY_TEST_TIMEOUT_MS, hookTimeout: HEAVY_HOOK_TIMEOUT_MS });
 */
export const HEAVY_TEST_TIMEOUT_MS = 30_000;
export const HEAVY_HOOK_TIMEOUT_MS = 60_000;
