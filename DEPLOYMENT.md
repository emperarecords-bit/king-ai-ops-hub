# Deployment & Operations (O-21)

How to run the Hub as a cloud-hosted app reachable from a desktop or phone
without Claude Code or a local terminal. This is **deployment readiness**, not a
production launch — §9 lists what is deliberately deferred.

The one supported path is **Fly.io + Fly Postgres** ([fly.toml](fly.toml),
[Dockerfile](Dockerfile)). One working path beats several half-templates.

---

## 1. Runtime dependency audit (Phase 1)

| Dependency | Value | Class |
|---|---|---|
| Node | ≥ 20.9 (image uses 22) | cloud-ready |
| Package manager | npm + committed `package-lock.json` | cloud-ready |
| Database | PostgreSQL 17 | cloud-ready |
| PG extensions | none beyond core (`pgcrypto`/`gen_random_uuid` is built-in on 17; FTS is core) | cloud-ready |
| Migrations | `npm run db:migrate` (Drizzle journal + `rls.sql`), advisory-locked | cloud-ready |
| Background runs | **durable worker** (`npm run worker`) over a Postgres job queue | cloud-ready (new this sprint) |
| Provider secrets | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (server-only) | cloud-ready |
| Encryption key | `APP_ENCRYPTION_KEY` (32B base64) | cloud-ready |
| Auth | Supabase Auth (`NEXT_PUBLIC_SUPABASE_URL` + anon key) | cloud-ready |
| Logging | structured JSON to stdout, redacted | cloud-ready |
| Health | `GET /api/health` (public) | cloud-ready |
| Backups | `pg_dump` scripts (local) → **managed-PG snapshots in cloud** | cloud-ready (cloud) / local-only (scripts) |
| **DB role** | dev uses superuser `king` (RLS bypassed); **prod MUST use `app_server`** | unresolved-until-configured |
| **Project Library folder** | local filesystem path per workspace | **local-only** — see §5 |
| Scheduled standing work | Windows Task Scheduler script | local-only (cloud: a Fly scheduled machine / cron — deferred) |
| External binaries | none | cloud-ready |

Nothing is silently worked around: the two non-green rows (DB role, local
folder) are called out in §2, §5 and §9.

---

## 2. Configuration contract (Phase 2)

`src/lib/env.server.ts` validates server config once, fails fast on missing
required vars (names only, never values), and in `NODE_ENV=production`
**refuses to boot** on placeholder/insecure config — including a `DATABASE_URL`
that uses a superuser (`king`/`postgres`) or the dev `app_server` password,
because RLS is only the enforced net when the app connects as the
non-superuser `app_server` role.

- **Server-only secrets** live only in `env.server.ts` (imports `server-only`).
- **Browser-visible** config is limited to `NEXT_PUBLIC_SUPABASE_URL` and the
  anon key; a unit test asserts no `NEXT_PUBLIC_*` name matches `KEY|SECRET|…`.
- Names + safe descriptions are in [.env.example](.env.example). Never commit
  real values.

Required in production: `DATABASE_URL` (as `app_server`), `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `APP_ENCRYPTION_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NODE_ENV=production`. Optional (sane defaults):
`APP_URL`, `RUN_TIMEOUT_MS`, `PROVIDER_TIMEOUT_MS`, `PROVIDER_MAX_RETRIES`,
`RATE_LIMIT_RUNS_PER_MINUTE`, `DEFAULT_MONTHLY_SPEND_LIMIT_MICROS`, `LOG_LEVEL`.

---

## 3. Database lifecycle (Phase 3)

- **Deploy-time migrations:** Fly `release_command = npm run db:migrate` runs
  before new machines take traffic.
- **Concurrency:** `migrate.ts` takes a Postgres **advisory lock** so two
  instances booting at once cannot migrate simultaneously; the second waits and
  finds the work already done (Drizzle journal makes re-apply a no-op).
- **Missing migrations at startup:** the app serves, but `/api/health` reports
  `migrations: not ok` (the latest expected table is absent) so the LB/alarms
  catch it.
- **Backup:** cloud = managed Fly Postgres automated snapshots + `fly pg …`
  on-demand dump; local = `scripts/backup.ps1` (nightly, +OneDrive, 30-day).
- **Restore:** `scripts/restore-verify.ps1` (local drill) / managed snapshot
  restore (cloud). A restore drill is part of §8 acceptance.
- **Rollback limitation:** additive migrations (all of 0001–0012) roll back by
  redeploying the prior image; a *destructive* migration (drop/rename) is **not**
  reversible by redeploy — restore from a pre-migration snapshot. None to date
  are destructive.

**Verified:** migrations 0000–0012 apply cleanly to an empty database (advisory
lock engaged), and the full suite (265 tests) passes against that clean DB.

---

## 4. Background execution (Phase 4)

Before this sprint, runs executed **inline** in the request/SSE handler — an
open browser or terminal had to survive the whole run. It now goes through a
**durable Postgres job queue** ([src/domain/jobs/jobs.ts](src/domain/jobs/jobs.ts)):

- Submitting/starting a run **enqueues** a `run_jobs` row (a partial unique index
  makes a duplicate live job impossible).
- A **worker** (`npm run worker`, a separate Fly process) claims one job at a
  time with `FOR UPDATE SKIP LOCKED` + a lease and executes it through the
  ordinary gated run path. The interactive SSE route claims the same job first,
  so it never double-runs.
- **Idempotency / no duplicate billing:** a claim is atomic; a run that was
  interrupted mid-execution is **not** re-run (that would re-bill the provider
  sequence) — it is marked `failed` with a *recoverable* reason and its task set
  `failed` (retryable). Provenance (the run row, steps, usage) is preserved.
- **Restart recovery:** on boot the worker reconciles jobs whose lease expired —
  a stale job whose task never started is requeued; one interrupted mid-run is
  recovered to the observable failed-recoverable state above.
- **Post-run decision extraction (O-20)** stays fail-safe: its failure never
  fails the completed task.

Verified by `tests/integration/run-jobs.test.ts` (atomic claim, idempotent
enqueue, interrupted→recoverable, stale→requeue).

Cross-tenant note: the worker reads the queue across workspaces (like the
standing-work tick), so its DB role must see `run_jobs`; the run itself still
executes through `withTenant`, so per-tenant isolation is unchanged.

---

## 5. Project Library storage boundary (Phase 5)

Today a workspace links a **local folder** (D-020): files discovered by walking
the folder, changes detected by content hash, extracted **text + hash** persisted
in `documents`/`document_chunks` (never the binary), retrieval over Postgres FTS.

**What breaks in the cloud:** the cloud app cannot see a local machine's disk.
`src/domain/documents/storage.ts` names the `StorageAdapter` seam and a
`storageStatus()` probe (used by health and the Documents UI). Critically,
`refreshIndex` now **stats the folder first** and aborts with a clear
"unavailable" error instead of falling through to the archival loop — so a
disconnected source **never** falsely archives every indexed document
(acceptance Test 4). Previously-indexed content stays queryable because the
extracted text lives in Postgres, not the folder.

**Deferred (see §9):** a cloud ingestion adapter (admin upload or synced
object store) so documents can be indexed without a local machine online. The
interface is defined; the implementation is not built this sprint. Retrieval
ranking, hashing, archival, provenance, and isolation are unchanged.

---

## 6. Health & observability (Phase 6)

- `GET /api/health` (public, unauthenticated): process, database, migration
  state, and worker liveness (queued backlog vs recent activity). 200 healthy /
  503 degraded. Exposes only aggregate up/down — never tenant data.
- Structured JSON logs to stdout with a redaction allow-list; full prompts,
  document chunks, credentials, and raw tokens are never logged. Each run
  carries the `runId` correlation id through its audit + log events
  (`run.started`, `run.completed`/`run.failed`, `run.recovered_interrupted`,
  provider-failure/retry inside the adapters, `decision.candidates_extracted`,
  `run_job.enqueued`, `document_folder.refreshed`, and tenant-violation errors).

---

## 7. Deployment artifact (Phase 7)

[Dockerfile](Dockerfile) builds one image (Next standalone) that runs either
role by command. [fly.toml](fly.toml) defines `web` + `worker` process groups,
managed Postgres via `release_command`, HTTPS, and the health check.

Owner one-time setup (needs a Fly account — cannot be done from here):

```bash
fly launch --no-deploy
fly postgres create && fly postgres attach <db>     # sets DATABASE_URL
fly secrets set NODE_ENV=production OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
    APP_ENCRYPTION_KEY=… NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=…
fly deploy
```

**Verified locally:** `npm run build` produces the standalone server; the image
layering copies the standalone output plus the source needed for `worker` and
`db:migrate`.

---

## 8. Mobile access (Phase 8)

Validated at a 375×812 viewport against the local server: sign in, projects
briefing, workspace dashboard, objectives, decisions, and documents all render
with **no horizontal overflow**; the workspace nav wraps rather than overflowing.
No phone-blocking layout defects found, so no UI changes were made (this is not
a redesign sprint).

**Owner step:** the live staging + real-device pass (start a run, watch status,
view Context used, accept/reject a suggested decision from an actual phone)
requires the Fly deploy in §7.

---

## 9. Deferred production-launch risks (explicit)

1. **DB role.** Dev connects as superuser `king`, so RLS is bypassed and only
   the app-layer `WHERE org/project` filtering isolates tenants (tested). In
   production the app **must** connect as `app_server`; the config layer now
   refuses to boot otherwise, but there is no automated test that runs the suite
   *as* `app_server` to prove the RLS policies themselves. Add one before launch.
2. **Cloud Project Library.** Local-folder indexing cannot run from the cloud;
   a cloud ingestion adapter is designed but not built. Until then, indexing is
   a local-machine operation and the cloud app serves already-indexed content.
3. **Standing-work scheduler.** The hourly tick is a Windows Task Scheduler
   script; the cloud equivalent (a scheduled Fly machine / cron) is not wired.
4. **Auth in the cloud.** Supabase redirect URLs, email settings, and session
   cookie domains must be configured for the deployed origin; open sign-up
   should be closed before any public exposure.
5. **Secrets rotation** (`scripts/rewrap-secrets.ts`) is untested against a
   managed DB.
6. **Worker scaling / SSE.** One worker is assumed; multiple workers are
   claim-safe but untested at concurrency. Long SSE runs assume a warm web
   machine (`auto_stop_machines = false`).
7. **No production observability integration** (metrics/error tracking) beyond
   stdout logs and the health endpoint.
8. **Backups in cloud** rely on managed-PG snapshots; the documented dump/restore
   drill is local-only and should be re-proven against the managed instance.

These are launch-gating items, not readiness blockers — the system is
*deployable* today; closing 1–4 is the path to *launchable*.
