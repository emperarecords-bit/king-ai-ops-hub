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

/**
 * Per-test bound for a test whose BODY performs a full git-blob walk of the committed migration folder
 * (`buildSourceManifestFromGit`, `deriveMigrationFacts`): one `git show` child process per migration plus the
 * journal. The cost is process-spawn bound, grows linearly with the migration count, and is far worse on
 * Windows/Git-Bash than on Linux CI. Reading the same bytes straight off disk (`readRuntimeMigrationSet`) takes
 * 59 ms, so this is spawn overhead, not hashing.
 *
 * Measured PRISTINE on a Windows 11 dev box (2026-11-11, 91 committed migrations, nothing else running,
 * `vitest run <file> --no-file-parallelism`, two reps):
 *
 *   one git-blob walk ................................. 13.7 - 14.9 s   (~160 ms per migration)
 *   gbackup-runtime-migration-set.ts test body ........ 14.6 - 15.3 s
 *   gbackup-scope-identity.ts test body ............... 14.1 - 16.9 s
 *   readRuntimeMigrationSet (disk bytes, no git) ...... 0.059 s
 *
 * 60 s is ~3.5x the worst pristine body (16.9 s), which absorbs the 2-3x slowdown this family is documented to
 * take under full-suite parallel contention (see HEAVY_TEST_TIMEOUT_MS above). Derive this bound from a PRISTINE
 * measurement only — never from a mean under load — and never trim it to just above the last observed time. Two of
 * these bodies previously carried a hard-coded 15_000 that was adequate at 61 migrations (~9.8 s) and then failed
 * 100% of the time on Windows once the folder reached 91: the bound never changed, the walk outgrew it. CI on Linux
 * kept passing, so the only symptom was that a developer on Windows could never get a fully green local run — the
 * condition in which a real regression gets waved off as "that one always fails".
 *
 * The walk itself is deliberately NOT optimized to fit a bound: `buildSourceManifestFromGit` is the producer in the
 * release ceremony, where exact committed-blob identity outranks latency. The slowness is environmental.
 *
 * This is NOT the generic heavy bound. HEAVY_TEST_TIMEOUT_MS (30 s) stays as-is for the fresh-DB / bootstrap work,
 * which does not spawn one process per migration.
 */
export const GIT_BLOB_WALK_TIMEOUT_MS = 60_000;
