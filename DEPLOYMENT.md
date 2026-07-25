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

1. **DB role — RESOLVED (O-22, see §10).** The full suite now runs with the
   application connection set to the non-superuser `app_server` role
   (`npm run test:rls`), a dedicated suite proves the RLS policies block direct
   cross-tenant reads/writes as `app_server`, and the worker/standing/health/
   provisioning paths were made app_server-safe. Dev *still* connects as superuser
   `king` for convenience (RLS bypassed locally); production must use `app_server`
   and the config layer refuses to boot otherwise. Residual: the dev `app_server`
   password is a placeholder — production sets a real one and `assertProductionSafe`
   rejects the dev value.
2. **Cloud Project Library — RESOLVED (O-23, see §11).** Documents can be
   uploaded from a browser/phone into object storage and indexed by the durable
   worker with the local machine offline; local + cloud sources coexist. Remaining
   for launch: provision the production bucket + set `STORAGE_DRIVER=s3` and the
   S3_* secrets (owner, one-time), and run the §11.6 backup/restore drill against
   the managed bucket. PDF/DOCX parsing is still out of scope (recorded
   `unsupported`).
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
*deployable* today; closing 2–4 is the path to *launchable* (1 is closed, §10).

---

## 10. Database roles & RLS enforcement (O-22)

RLS is the **independent database-level** tenant boundary, under the app-layer
`WHERE org/project` filters (which remain required). It is only a real net when
the app connects as a role that cannot bypass it. This section is the contract.

### 10.1 Role model (three roles)

| Role | Attributes | Used by | Must NOT have |
|---|---|---|---|
| **Migration role** (`king` locally / managed-PG owner) | superuser/owner | `npm run db:migrate`, DDL, `rls.sql`, test fixtures | — (privileged by design; never used by the running app) |
| **`app_server`** | `LOGIN NOSUPERUSER NOBYPASSRLS`, owns nothing | web process, worker, all background jobs, every app query | `SUPERUSER`, `BYPASSRLS`, table/schema ownership, `TRUNCATE/REFERENCES/TRIGGER` |
| **`app_system`** | `NOLOGIN NOSUPERUSER BYPASSRLS` | owns the `SECURITY DEFINER` `app.*` dispatch functions only | login; any grant beyond what those function bodies touch |

Both `app_server` and `app_system` are created idempotently by
[`src/db/rls.sql`](src/db/rls.sql) (applied on every `npm run db:migrate`), which
also asserts `app_server` is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`.
Privilege grants are the explicit `grant …` lists there — **not** `GRANT ALL`.

### 10.2 Why `app_system` exists (the cross-tenant escape hatch)

Four operations are inherently cross-tenant and cannot run under a per-tenant
GUC: the worker claiming the next job across workspaces, the standing tick
finding due schedules, the health worker-liveness count, and adopting a seed
placeholder profile at first sign-in. Each is confined to a fixed
`SECURITY DEFINER` function in schema `app`, owned by `app_system` (BYPASSRLS),
`EXECUTE`-granted to `app_server`. `app_server` gains **no general** cross-tenant
read — only the exact, audited behavior of those bodies. Every run then executes
through `withTenant()` with RLS fully enforced.

### 10.3 Tenant-session contract

- `withTenant(ctx, fn)` opens a transaction and sets transaction-local GUCs
  `app.user_id`, `app.org_id`, `app.project_id` via `set_config(..., true)`
  (`SET LOCAL` semantics — never persisted, so nothing leaks across the pool).
  Policies read them through `app.current_*()`, which return `NULL` when unset →
  **fail closed**.
- `withUser({userId}, fn)` is the narrower pre-tenant bootstrap (login) boundary:
  only `app.user_id` is set; navigation-table policies key off membership so a
  user resolves exactly their own orgs/projects.
- Both **fail closed** on a missing/malformed identifier (`tenant.context_invalid`
  is logged) and both log `rls.rejected` on a database WITH CHECK refusal.
- Org/project IDs are **never** taken from unvalidated browser input — the client
  supplies a project *key*, resolved against the caller's memberships.

### 10.4 Connection URLs & process config

```bash
# Migration role — DDL + migrations only (release_command). NEVER the app.
DATABASE_MIGRATION_URL=postgresql://<owner>:<pw>@<host>:5432/king_ai_hub

# Application role — web + worker + jobs. NOSUPERUSER, NOBYPASSRLS.
DATABASE_URL=postgresql://app_server:<app_pw>@<host>:5432/king_ai_hub
```

- **Web** (`node server.js`) and **worker** (`npm run worker`) both read
  `DATABASE_URL` (the `app_server` URL). On Fly they are the two process groups
  in [fly.toml](fly.toml); the `release_command` migrate step is the only thing
  that uses `DATABASE_MIGRATION_URL`.
- Production **must** set a real `app_server` password; `assertProductionSafe`
  (env.server.ts) refuses to boot on the dev placeholder or a superuser URL.

### 10.5 Owner one-time role setup (managed Postgres)

`rls.sql` creates the roles, but on managed Postgres you own the passwords:

```sql
-- as the database owner:
alter role app_server with login password '<strong-app-password>';
-- app_system stays NOLOGIN; no password needed.
```

Then set `DATABASE_URL` to the `app_server` URL and `DATABASE_MIGRATION_URL` to
the owner URL, and deploy. `npm run db:migrate` (release command) applies the
grants/policies/functions idempotently.

### 10.6 Clean-environment setup + RLS verification

```bash
# Fresh database from zero, then prove RLS as app_server:
createdb king_ai_hub
DATABASE_MIGRATION_URL=postgresql://<owner>@<host>/king_ai_hub npm run db:migrate
npm run test:rls        # full suite with the app connection = app_server
```

`npm run test:rls` points `DATABASE_URL` at `app_server`, keeps
`DATABASE_MIGRATION_URL` for fixtures, and **prints the resolved `current_user`**
so an accidental superuser run is obvious. A guard test fails if that role is a
superuser or `BYPASSRLS`. Verified: 276/276 pass as `app_server`, including a
dedicated suite that reads/writes across tenants and is refused by the database.

### 10.7 Database-credential rotation

1. Set a new password on the app role: `alter role app_server with password '<new>';`.
2. Update the `DATABASE_URL` secret (`fly secrets set DATABASE_URL=…`) — this is a
   separate secret from `DATABASE_MIGRATION_URL`.
3. Roll the web + worker machines (`fly deploy` or `fly machine restart`) so they
   reconnect with the new credential; the pool reconnects, no schema change.
4. The migration-role password rotates the same way but is only needed at deploy
   time. Neither rotation touches encryption keys (SECURITY.md §6) — they are
   independent.

### 10.8 Tables intentionally without a project-scoped RLS predicate

All 29 public tables have RLS enabled **and** forced. The following are scoped by
something other than `(org, project)`, by design — not exclusions from RLS:

| Table | Policy basis | Why |
|---|---|---|
| `profiles` | `id = current_user` | per-user, not per-tenant |
| `organizations`, `memberships` | org membership | navigation; a user sees only orgs they belong to |
| `projects`, `project_members` | project membership | navigation; resolves at bootstrap before a workspace is chosen |
| `departments`, `audit_logs` | `org_id = current_org` | org-scoped (an employee's dept, org-level events) |
| `rate_limit_buckets` | open (`true`) | holds no tenant data — scope lives inside `scope_key` |

"Decision candidates" are rows in `decisions` (`status='proposed'`), and "context
manifests / provenance" are the `runs.context_manifest` column — both covered by
their table's `_tenant` policy. `document_jobs` (O-23) is a project-scoped tenant
table with the standard `_tenant` policy. There is **no** tenant table without RLS.

## 11. Object storage & Cloud Project Library (O-23)

The Project Library works in the cloud with the user's machine offline: files are
uploaded into managed S3-compatible object storage, indexed by the durable
worker, and retrieved identically to local-folder documents (§5 still describes
the local adapter, which is unchanged and coexists).

### 11.1 Storage model

- Source **files** live in object storage; PostgreSQL keeps only metadata +
  extracted text/chunks. Per document row: `source` (`local_folder`/`cloud_upload`),
  `source_id` (stable identity), `object_key`, `mime_type`, `size_bytes`,
  `sha256`, `source_modified_at`, `ingested_at`, `status`, `error_message`,
  provenance via the audit log.
- **Uploads/downloads are server-mediated** (browser → app → store): credentials
  never reach the browser, and there are **no public buckets and no presigned/
  guessable object URLs**. The worker fetches objects with server credentials.
- **Object keys are tenant-partitioned**: `org/<orgId>/project/<projectId>/doc/<sourceId>/<versionHash>`.
  A key is meaningless outside its workspace, and `keyBelongsToTenant` re-checks
  the prefix before any GET/DELETE.

### 11.2 Identity & version rule

Within a workspace a cloud document's stable `source_id` is its **normalized
filename**. Re-uploading the same filename updates that document in place; it is
never duplicated.
- same source + same hash → no-op (no re-index).
- same source + new hash → new version: the row id is retained (provenance), the
  new immutable version object is stored under its own `versionHash` key, and the
  worker replaces the chunks **atomically** at index time.
- a cloud upload and a local-folder file sharing a name are **different sources**
  (separate adapters; partial-unique indexes per adapter) and never merge.
- a missing backing object → `source_unavailable` (row retained, never deleted).

### 11.3 Drivers & configuration

`STORAGE_DRIVER=local` (filesystem — dev/test) or `s3` (production). The S3 client
is dependency-free SigV4 and works with any S3-compatible endpoint. Required env
when `s3` (production **fails to start** if any is missing/placeholder —
`assertProductionSafe`): `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Ceilings: `MAX_UPLOAD_BYTES`
(default 2 MB), `MAX_UPLOAD_BATCH` (default 20).

Owner setup (Fly Tigris shown; R2/MinIO/AWS analogous):

```bash
fly storage create                      # provisions a Tigris bucket, sets AWS_* secrets
# expose them under our names + enable the driver:
fly secrets set STORAGE_DRIVER=s3 \
    S3_ENDPOINT=https://fly.storage.tigris.dev S3_REGION=auto \
    S3_BUCKET="$BUCKET_NAME" \
    S3_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
```

**Bucket policy:** private (no public read/write, no public listing). Only the
`app_server`/worker credential has access. Both the web and worker process groups
read the same S3_* secrets.

**Minimal permission policy** (scope the storage key to exactly what the Hub
uses — no account-wide admin, no cross-bucket access; no credentials shown):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HubObjectRW",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/*"
    },
    {
      "Sid": "HubListOwnBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<BUCKET>"
    }
  ]
}
```

`s3:PutObject`/`GetObject` cover upload + worker fetch; `HeadObject` is authorized
by `GetObject`; `DeleteObject` is used by archival cleanup + failed-upload cleanup;
`ListBucket` is scoped to the one bucket. No `s3:*`, no bucket-policy/ACL write,
no account-level actions. On Fly Tigris the `fly storage create` key is already
bucket-scoped; on AWS/R2 attach the policy above to a dedicated IAM user/token.

### 11.8 Live validation status (O-23 production acceptance)

The `S3ObjectStore` (dependency-free SigV4) is **validated against a real
S3-compatible server** — local **MinIO**, same protocol as Tigris/R2/AWS — by
`npm run test:s3` (requires a running MinIO + private bucket; not part of the
hermetic CI suite). It exercises: raw PUT/GET/HEAD/DELETE round-trips; upload →
tenant-partitioned object in the bucket → durable index → active → retrieval with
`cloud_upload` provenance; private-bucket anonymous access refused (403);
idempotent re-upload + atomic replacement; worker-restart recovery with no
duplicate chunks; object-layer isolation (a foreign-tenant key is refused before
any fetch); and `/api/health` reporting `storage: driver=s3` healthy.

A local **backup/restore drill** (Postgres `pg_dump` + MinIO `mc mirror` →
restore to a clean DB + backup bucket) confirmed: cloud document rows + chunks
restore intact and queryable, the restored DB sha256 matches the backed-up
object's sha256, and **zero cross-tenant object references** after restore.

**Live managed-bucket acceptance (2026-07-25) — DONE.** Validated on the real
staging deploy (`king-ai-ops-hub-staging.fly.dev`, private Tigris bucket),
observed server-side — no simulated results:
- `/api/health` → `storage: driver=s3` healthy; anonymous object GET → **403**.
- Managed S3 suite (`npm run test:s3` pointed at the live Tigris bucket) → **7/7**.
- Full authenticated flow: Supabase sign-in → org + workspace → Markdown upload →
  tenant-partitioned key `org/<id>/project/<id>/…` → durable index job `done` in
  **1 attempt** → document `active` → real multi-model run (OpenAI → Anthropic
  review → revision → consolidate) retrieved it with
  `retrieved_documents.source = cloud_upload`, and the model used the unique fact.
- Human-in-the-loop: decision **suggested** (Accept/Reject/Defer), not auto-applied.

**Deployment findings — apply to any new environment:**
1. **DB memory ≥ 1 GB (launch requirement).** Fly Postgres at the 256 MB default
   thrashes under the app pool + 2 s worker polling + health checks → primary
   fails its own health check → cluster reports **"no active leader"** → app 503.
   Scaled the staging DB to 1 GB; it recovered immediately. Do not deploy on 256 MB.
2. **Tigris credentials use `AWS_*` names.** `fly storage create` injects
   `AWS_ENDPOINT_URL_S3 / AWS_REGION / BUCKET_NAME / AWS_ACCESS_KEY_ID /
   AWS_SECRET_ACCESS_KEY`. Fly secrets are **write-only** (can't be read back to
   copy into `S3_*`), so the S3 reader + env validator accept `AWS_*` as a
   fallback for the `S3_*` contract. `STORAGE_DRIVER=s3` lives in `fly.toml [env]`.
3. **`fly postgres connect` defaults to the `postgres` DB** — pass
   `--database <appdb>` to reach the `app` schema / RLS functions.
4. Set role passwords in psql and the matching `fly secret` **from one place**;
   hand-copying drifted repeatedly (four failed migrate attempts on auth).

**Still owner-gated (operational sign-off, not architecture):** the managed
backup/restore drill (§11.6 against the live PG + Tigris), the physical-phone
pass, and a live UI unsupported-file upload. Minor: the "Context used" panel does
not render a `cloud_upload` badge though the API records the provenance correctly.

### 11.4 Storage security controls

Server-generated keys; MIME allowlist (Markdown/plain-text only); filename
normalization + path-traversal rejection (basename only); content-length limit;
strict UTF-8 decode; binary-as-text rejection (NUL / control-byte heuristic);
checksum (sha256) of stored bytes; no execution of uploaded content; indexed
content stays wrapped as untrusted context in prompts (unchanged). PDF/DOCX are
recorded `unsupported` and never enter retrieval.

### 11.5 Health

`GET /api/health` gains a `storage` check: a cheap HEAD on a probe key confirms
the store is reachable + authorized (200) or degraded (503). It never lists or
exposes bucket contents.

### 11.6 Backup & restore

- **Backup:** (1) PostgreSQL as in §3 (`pg_dump` / managed snapshot — includes all
  document metadata + chunks, so **retrieval survives on the DB backup alone**);
  (2) the object bucket — Tigris/R2/S3 provide versioning + their own snapshot/
  replication; enable bucket versioning so a deleted/overwritten object is
  recoverable.
- **Restore drill (Test 9):** restore Postgres + bucket into a clean staging
  environment. Because object keys embed `org/project`, uploaded files remain
  associated with the correct workspace and no cross-tenant reference is possible.
  Documents whose chunks restored from the DB are immediately queryable;
  otherwise `Retry` re-indexes deterministically from the restored object.

