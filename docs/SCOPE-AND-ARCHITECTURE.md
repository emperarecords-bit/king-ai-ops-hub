# King AI Ops Hub — Scope & Architecture Brief

_Generated 2026-11-08. Source: static read of `C:\Users\baldd\dev\king-ai-ops-hub` on branch `fix/ops-chat-timeout-lean-inspection` (3 commits ahead of `main`, all Ops-Chat timeout fixes; no schema changes on this branch). Paths are relative to the repo root._

> **Docs caveat:** the top-level `ARCHITECTURE.md` / `ROADMAP.md` still describe executors as "deferred." The code has shipped well past that (Phase 2/2E connectors + the P1d reliability layer). **Treat the code as ground truth; the older `.md` files are historical.**

---

## 1. What it is (scope)

The Hub is a **multi-agent AI operations platform**. You create **workspaces** (called `projects` in code — e.g. AccurateBids, StressProbe, Stocks), staff each with AI **"employees"** (`agents`), and give them **tasks**. Each task runs through a governed state machine: a **primary** agent drafts, a **reviewer** agent critiques, one revision, then a deterministic consolidation. Consequential actions (merging a PR, deploying an edge function, promoting a Vercel build) never happen directly — they become **approvals** the owner confirms, after which a **governed connector** executes them with fail-closed safeguards.

On top of this sits **Ops Chat** — a conversational "front door" meant to feel like this chat: a read-only "pulse" of what needs attention, plus chat tools that *propose* actions you confirm. The north-star framing (per memory) is to make the Hub work "like this chat, not a confusing dashboard."

The honest current status (`STATUS-SUMMARY.md`): **the capability is built; adoption is the gap** — ~15 real tasks, ~$0.44 spend. The active branch is hardening Ops Chat timeouts, not adding features.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| App | **Single Next.js 16 app** (App Router, RSC + Server Actions + Route Handlers), React 19, TypeScript 5.9 strict. **Not** a monorepo — one deployable, layered `src/` tree with ESLint-enforced downward deps (monorepo rejected, `DECISIONS.md` D-002). |
| DB | PostgreSQL via `postgres.js` driver + **Drizzle ORM** 0.45; Postgres RLS under a `NOBYPASSRLS` `app_server` role |
| Auth | Supabase Auth (auth only — not the database) |
| AI providers | `@anthropic-ai/sdk` + `openai` (+ openai-compatible for Gemini/DeepSeek); the **only** SDK consumers live in `src/providers/` |
| Validation | Zod 4; SQL AST via `pgsql-ast-parser` |
| Hosting | **Fly.io** (staging + prod apps), Docker image, Tigris/S3 object storage |
| Worker | A durable background run worker (`scripts/worker.ts`, `npm run worker`) deployed as a second Fly process group |
| Side service | `services/voice-line/` — a standalone voice/telephony microservice (own Dockerfile + fly.toml) |

---

## 3. Architecture

### Layered `src/` tree
- `src/app/` — screens + APIs. Per-workspace routes under `src/app/p/[projectKey]/*` (tasks, approvals, agents, objectives, knowledge, documents, decisions, portfolio, repo browser, audit, usage, reporting, settings). APIs under `src/app/api/*`.
- `src/domain/` — business logic (~45 sub-modules).
- `src/orchestration/` — the run state machine + prompt assembly.
- `src/providers/` — the only place that talks to an LLM SDK (`registry.ts`, `anthropic.ts`, `openai.ts`, `openai-compatible.ts`, `pricing.ts`).
- `src/db/` — schema, tenant connection, `rls.sql`.

### Run lifecycle (the core engine)
1. **Enqueue** — `enqueueRun()` (`src/domain/jobs/jobs.ts`) inserts a durable `run_jobs` row (partial-unique on a live task → idempotent). Used by the interactive path, the standing-work tick, and the Ops Chat confirm path.
2. **Claim** — the worker (`scripts/worker.ts`) loops `claimNextJob()` → `runClaimedJob()` using `FOR UPDATE SKIP LOCKED` + a lease. **There is no SSH/remote `startRun`** — "startRun" is an in-process function run under a claimed job's tenant context.
3. **Run** — `startRun`/`resumeRun` (`src/domain/tasks/runner.ts`): preflight (rate-limit, budget `assertWithinBudget`, **P1a agent pinning** — executes the exact assigned primary/reviewer agent, fails closed, never re-derives), then `executeAndFinalize`.
4. **Engine** — `src/orchestration/engine.ts`: fixed 4-step machine (`MAX_STEPS=4`, `MAX_REVISIONS=1`): primary → review → one revision → deterministic consolidate (no 3rd model call). `provider='both'` ⇒ OpenAI primary + Anthropic reviewer (**cross-vendor by construction**, D-005).
5. **Reliability (Hub P1d crash-safety)** — every provider call is fenced by a durable dispatch *intent* (`reliabilityState='dispatching'`) + a *result checkpoint* (`run_execution_checkpoints`), committed per step. `resumeRun` replays checkpoints with **no second provider call and no re-bill**; an uncertain dispatch resolves to `reconciliation_required` with zero auto-retry; finalize is idempotent two-phase.

### Governed execution (the single choke point)
`executeApprovedAction()` in `src/domain/execution/dispatch.ts` re-reads the approval, requires `projectRole==='admin'`, status `approved`, unexpired, **payload-hash match**, a fresh payload-bound confirmation, idempotency under the append-only audit lock, and that the executor is **explicitly enabled**. An action type not in the `resolveExecutor()` registry can never execute.

**Fail-closed enablement:** `EXECUTORS_ENABLED` is a comma-separated allowlist — **unset ⇒ everything disabled**; `EXECUTORS_KILL_SWITCH=1` empties it instantly. Only two risk classes are dispatchable at all: `reversible_internal_write` and `external_reversible` (`executor-policy.ts`). Anything `destructive_irreversible` is blocked at the gate.

### Ops Chat (the front door)
- **Pulse landing** (`src/app/ops/`, `src/domain/opschat/pulse.ts`): assembled deterministically (**$0, no model call**) from the Morning Briefing + open owner-questions, strictly scoped to the signed-in owner's projects.
- **Chat** (`src/app/api/ops-chat/route.ts`): an SSE tool-loop on `claude-sonnet-5`, per-user rate-limited, with a whole-request watchdog (the focus of the current branch). Read tools + `propose_*` tools that **never write** — each records a proposal card.
- **Single write path** (`src/app/api/ops-chat/confirm/route.ts`): re-authenticates, re-validates role/tenant, then dispatches to answer-question / decide-approval / create-task+enqueue / governed connector action.
- **Answer modes:** Quick vs Reviewed is enforced server-side (`src/domain/tasks/review-policy.ts`) — a Quick request against a non-`quick_exempt` task is **forced to Reviewed** (fail-safe). **Council** (`src/domain/opschat/council.ts`) is owner-triggered, **advisory and read/review-only** (a static guard test forbids mutation imports): fans out to ≤3 reviewers + one synthesis, quorum 2, no retries, fails safe.

---

## 4. Data model

**~60 tables**, schema source of truth in `src/db/schema/` (`tables.ts` ~2492 lines, `enums.ts`, `trading-tables.ts`, `verification-tables.ts`). Every tenant table carries `org_id` + `project_id`.

- **Identity/tenancy:** `profiles` (mirrors Supabase `auth.users`), `organizations`, `memberships`, `projects` (= workspace; has `key`, `retrievalMode`, `ownerAgentId`), `project_members`, `departments`.
- **Employees** = `agents` table: org+project scoped; `role` (primary/reviewer), `title`, `departmentId`, `reportsToId`, `provider`+`model`+`systemPrompt`+`temperatureMilli`+`maxOutputTokens`, `enabled`.
- **Work:** `tasks`, `task_dependencies`, `objectives`, `milestones`, `task_schedules` (standing work), `conversations`, `work_items`.
- **Runs:** `run_jobs` (durable queue, lease/heartbeat), `runs` (reproducibility hashes, review-mode trail, `reliabilityState`), `run_steps`, `run_execution_checkpoints` (append-only), `messages` (immutable transcript).
- **Governance:** `approvals` (actionType + Zod payload + `payloadSha256` + `expiresAt`), `owner_questions` (open/answered/dismissed; answer also written into workspace knowledge), `executor_executions` + `executor_execution_attempts` (full provenance state machine, **"storage only: no executor enabled"** by default), `audit_logs` (**append-only, hash-chained per org**, UPDATE/DELETE blocked by trigger).
- **Connector config (NO secrets in DB):** `integration_secrets` (AES-256-GCM ciphertext), `api_tokens` (SHA-256 hash only), `github_repo_links`, `supabase_project_links`, `vercel_project_links` (opaque refs only — platform tokens stay in Fly secrets).
- **Notifications (migration `0078`):** `notification_events` (in-app inbox), `notification_messages` (outbound email/digest), `notification_message_events`, `notification_preferences` (quiet hours + tz).
- **Verification/evidence (`verification-tables.ts`, migs `0071`–`0076`):** `verification_requests`, `verification_evidence`, `verification_runner_keys`, `verification_upload_grants`.
- **Data classification:** enum `data_classification = ['live','demo','seed']` (precedence seed > demo > live), stamped immutably at dispatch on projects/agents/tasks/runs/usage_events (HUB-009).
- **Billing/limits:** `usage_events`, `spend_limits`, `rate_limit_buckets`, migration-seeded immutable `pricing_schedules`.
- **Trading/portfolio** (`trading-tables.ts`): a **ledger only** — "nothing here executes anything"; no brokerage integration.

**RLS / tenancy:** access is only through boundary helpers (`withTenant`, `withRunner`, `withOrg`, `withUser`, `withPurgeTenant` — `src/db/tenant.ts`) that open a transaction and stamp transaction-local GUCs (`app.user_id`/`app.org_id`/`app.project_id`) read by `src/db/rls.sql` (74 KB, applied post-migrate). Three DB roles: `app_server` (RLS-enforced, the app), `app_system` (owns `app.*` functions), `purge_agent` (only role allowed to delete immutable version rows). App code is ESLint-barred from importing the raw DB client.

**Migrations:** 84 files in `drizzle/` (`0000`–`0083`), Jul 23 → Oct 11 2026. Journal count (84) matches files; CI enforces zero drizzle-diff. Pinned invariant (`scripts/backup/production-pins.ts`): `expectedMigrationEndpoint=0083_graceful_zemo`, `expectedCommittedMigrationCount=84`.

---

## 5. Integrations & governed connectors

| Connector | Code home | Capabilities | Risk / status |
|---|---|---|---|
| **GitHub (git_pr)** | `src/domain/github/` + `git-pr-executor.ts` | `create_pr`, `merge_pr`, `rerun_failed_workflow`, `revert_commit` | `reversible_internal_write`/`external_reversible`. Hardened: placeholder guard, shrink guard; merge refuses draft/closed/stale-SHA/non-green CI; revert builds exact inverse on a new branch. |
| **Supabase** | `src/domain/supabase/` | **read** (inspect project/fns/migrations); **deploy** (`supabase_deploy`: one edge fn from an exact 40-hex SHA, reversible by redeploying prior SHA) | deploy = `external_reversible`. **`supabase_sql` has NO live executor** — classed `destructive_irreversible`, blocked at the gate; only AST-validated dry-run ships. |
| **Vercel** | `src/domain/vercel/` | **read** (inspect project/deployments); **mutation** (`vercel_mutation`: redeploy / promote / rollback, bound to exact deployment ids + SHAs + current-prod pointer) | `external_reversible`; refuses non-READY / wrong-SHA / moved-pointer. |
| **AccurateBids tap-in** | `accuratebids-quote-executor.ts` | strict `external_http` quote push | external_reversible. |
| **Owner notifications** | `src/domain/notifications/` | in-app inbox + email via **Resend** (`channels/email-resend.ts`) | Fail-closed gate (`NOTIFICATIONS_ENABLED` + adapter + config). SMS reserved, no adapter in v1. |

All write-executors are **disabled by default** and require an explicit `EXECUTORS_ENABLED` entry.

---

## 6. Infrastructure & deployment

- **Fly topology:** one image, two process groups by command (`web = node server.js`, `worker = npm run worker`).
  - `fly.toml` → `king-ai-ops-hub-staging`, region `iad`, 512 MB, `release_command = npm run db:migrate`, health check `GET /api/health`.
  - `fly.production.toml` → `king-ai-ops-hub-prod`, **1 GB**, `min_machines_running = 2`. Deployed only via a **receipt-gated ceremony** with a digest-pinned image (`fly deploy --image …@sha256:<digest>`).
- **Docker:** multi-stage on `node:22-bookworm-slim`, non-root `app` user, Next standalone + `src`/`scripts`/`drizzle` for the worker/migrate. Immutable source identity baked at `/app/source-identity.json`.
- **Local DB:** `docker-compose.yml` — `postgres:17-alpine`, **host port 5433** (deliberately not 5432), `npm run db:up`.
- **Migrations run as a Fly release command** (migrate-then-deploy). `scripts/migrate.ts` runs ordered stages under a Postgres advisory lock: advisory lock → **G-Backup pre-migration receipt gate** → ensure `app` schema → Drizzle migrate → apply `rls.sql` → optional verify.
- **Secrets/env:** single reader `src/lib/env.server.ts` (`server-only`, Zod-validated; `assertProductionSafe` rejects placeholders and superuser/dev DB URLs in prod). Fly secrets are write-only.
- **Object storage:** Tigris/S3 (`STORAGE_DRIVER=s3`; `AWS_*` accepted as fallback for `S3_*`). Receipt publishing uses a **separate least-privilege** credential set (`GBACKUP_RECEIPT_S3_*`), never the app creds.
- **DB size:** **≥1 GB is a launch requirement** (256 MB OOM-looped).
- **Providers/reliability:** `RUN_TIMEOUT_MS=180000`, `PROVIDER_TIMEOUT_MS=90000`, `PROVIDER_MAX_RETRIES=2`, `RATE_LIMIT_RUNS_PER_MINUTE=10`, default monthly spend cap $25. Each SDK is built with `maxRetries:0` — retry policy belongs to the engine, once, uniformly.
- **CI (`.github/workflows/`):** `p1-release-gates.yml` (typecheck + prod build + **migration no-drift check** + two ephemeral-Postgres DB profile jobs running the full RLS/tenancy vitest + secret scan). Deploys are **manual `fly deploy`** (no workflow deploys). Four manual receipt-ceremony workflows (sign/publish × staging/prod) hold Ed25519 signing keys in protected GitHub Environments and publish create-only to WORM S3.

---

## 7. What's built vs. gaps

### Solidly built
- The full run engine: durable queue + worker, P1a agent pinning, P1d crash-safe checkpointed dispatch (no re-bill on resume), cross-vendor primary/reviewer.
- Governed execution with a single audited choke point, payload-hash binding, risk-class gate, and fail-closed enablement.
- Three real connectors (GitHub / Supabase-deploy / Vercel-mutation) with per-operation safety (SHA pinning, CI-green checks, pointer checks).
- Ops Chat pulse + propose/confirm split + Council advisory layer.
- Owner notifications (in-app + email), hash-chained audit log, data-classification stamping, per-org RLS with a dedicated purge role.
- A serious CI gate (migration drift, RLS tests on ephemeral DBs) and a signed-receipt release ceremony.

### Gaps / things to flag (with paths)
1. **Phase-2 connectors are built but NOT yet live in prod.** Per the (untracked, memory-caveated) `docs/operations/phase2-release-packet.md`: prod is release **v62** but still runs the **v56 image** (v57–v62 were config-only). **Migrations `0079`–`0083` are unapplied in prod** — the `supabase_project_links` / `vercel_project_links` tables and the three new `action_type` enum values don't exist in prod yet. All five are purely additive (no destructive DDL). The release runs later under the receipt ceremony on your authorization. _Confirm against the live DB before relying on these in prod._
2. **VER-001 verification layer is NOT wired into the live run path** (`src/domain/verification/index.ts` header). The honesty/false-completion adjudication exists and is proven only by `scripts/verification-acceptance-demo.ts`. **VER-002** external-runner ingestion is mechanism-only — upload grants **disabled by default**, and five `VERIFICATION_RUNNER_*` flags default `'0'`.
3. **`file_write` is a no-op dry-run shim** (`resolveExecutor` → `NoopDryRunExecutor`: declares `file_write`, dry-run only, `externalSideEffects: false`, and throws on live mode). The real Firecracker sandbox (`firecracker-sandbox.ts`, `file-write-*.ts`, `sandbox-boundary.ts`) is built but is not the live path. **Resolved 2026-11-08** — the "two enablement models" reading was wrong in one decisive respect: `executor-enablement-policy.ts` had **zero production call sites** and was referenced only by two test files, so there was never a second live gate to merge. It was deleted, and the adversarial assertions it carried now run against the real gate via the exported `isExecutorEnabled` + `resolveDispatchPolicyFromEnv`. One model remains: `EXECUTORS_ENABLED` / `EXECUTORS_KILL_SWITCH`, which `file_write` already passed through unchanged. Remaining wart: the gate keys on the resolved **executor id**, so enabling `file_write` means putting `noop_dry_run` in the allowlist — `file_write` is not independently addressable, and that entry would enable the no-op for any action type routed to it.
4. **Stale/contradictory docs & tool prose from stacking.** Some Ops Chat tool descriptions in `src/domain/opschat/tools.ts` still say Vercel/Supabase are "read-only — no deploy/promote action exists yet," and `ARCHITECTURE.md`/`ROADMAP.md` call all executors "deferred" — yet the mutation executors shipped. Code leads docs. Cleanup candidate.
5. **Notification email sender is partly inert** — schema + registry shipped (`0078`), but the email *sender* was explicitly a later PR; messages queue without dispatch until the sender + flags land. Confirm the sender is deployed and `EMAIL_API_KEY`/`EMAIL_FROM` set.
6. **Cloud DB migration stays blocked** until the enforced G-Backup pre-migration gate is merged/configured (README; `scripts/backup/premigration-gate.ts`).
7. **Capability-gating secrets** that silently disable features if unset: `STORAGE_DRIVER=s3`+`AWS_*`/`S3_*` (prod refuses to boot without), `EMAIL_API_KEY`+`EMAIL_FROM`, `GEMINI_API_KEY`/`DEEPSEEK_API_KEY` (optional vendors), the `GBACKUP_RECEIPT_S3_*` set + signing key, and prod `DATABASE_URL` must be the non-superuser `app_server` role.
8. **Adjacent/experimental subsystems** not part of the core loop: `src/domain/trading/` (paper ledger, no live brokerage), `services/voice-line/` (standalone service), and the Phase-5 MCP server (`src/domain/mcp/` + `src/app/api/mcp/`, token-scoped tools).
9. **Static drift = none** (journal 84 = files 84, CI enforces zero diff). But applied-state drift vs the live prod/staging DBs was **not verified here** (no live DB connection) — item #1 is asserted from the release packet only.

### The headline
The Hub's design story is **"nothing consequential happens without an owner-confirmed, hash-bound, reversible, fail-closed approval."** The build largely delivers that. The open work is **turning the finished Phase-2 connectors on in prod** (via the receipt ceremony), **wiring the verification layer into live runs**, **reconciling the two file-write enablement models**, and **cleaning up docs/tool prose that lag the code** — plus the real business challenge the status doc names: **adoption**, not capability.
