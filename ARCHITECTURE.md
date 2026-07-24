# Architecture — King AI Operations Hub

> Status: living document. Last revised at the completion of Phase 1.

## 1. Product in one paragraph

A single owner-operated control plane for delegating work to OpenAI and Anthropic
models across five strictly isolated project workspaces. The owner submits a task
to a project; the platform loads **only that project's approved context**, sends it
to a primary model, optionally has the other provider's model review the output,
allows the primary model exactly one revision, and produces a consolidated result.
Nothing consequential happens to the outside world without an explicit human
approval recorded in an immutable audit trail.

## 2. Non-negotiable invariants

These are the properties the whole design exists to protect. Every module is
answerable to them.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | No data crosses a project boundary — context, messages, artifacts, secrets, memory | `TenantContext` required on every repository call + Postgres RLS |
| I2 | Provider API keys never reach the browser | Keys read only in `src/lib/env.server.ts`, which throws if imported client-side; `server-only` guard |
| I3 | Model output is untrusted input | All model output parsed through Zod before it can influence control flow; rendered as text, never as HTML |
| I4 | No consequential action executes without human approval | `approvals` table + `requiresApproval()` policy gate; the executor refuses any action lacking an `approved` record |
| I5 | Agent loops are bounded | Orchestration engine is a fixed-length state machine (max 4 steps), not a while-loop |
| I6 | The audit trail cannot be altered | Append-only table, `UPDATE`/`DELETE` blocked by trigger, hash-chained rows |
| I7 | Messages are immutable | Same trigger pattern on `messages` |
| I8 | Spend is bounded | Pre-flight budget check per project per period; run refuses to start when over limit |

## 3. Trust boundaries

```
                        ┌───────────────────────────────────────────┐
  ①  Browser  ─────────►│  TB-1: Next.js server (Node runtime)      │
     (untrusted)        │  - session verified via Supabase Auth     │
                        │  - every input parsed by Zod              │
                        │  - TenantContext derived server-side ONLY │
                        └───────┬───────────────────────┬───────────┘
                                │                       │
                    ② TB-2      │                       │  ③ TB-3
              (tenant boundary) │                       │ (egress boundary)
                                ▼                       ▼
                     ┌────────────────────┐   ┌──────────────────────┐
                     │ Postgres/Supabase  │   │ OpenAI / Anthropic   │
                     │ RLS + app-layer    │   │ untrusted RESPONSES  │
                     │ scoping            │   │ come back across ④   │
                     └────────────────────┘   └──────────┬───────────┘
                                                         │ ④ TB-4
                                                         ▼
                                              ┌──────────────────────┐
                                              │ Model output = data. │
                                              │ Zod-validated before │
                                              │ it can do anything.  │
                                              └──────────┬───────────┘
                                                         │ ⑤ TB-5
                                                         ▼
                                              ┌──────────────────────┐
                                              │ Approval gate → the  │
                                              │ only path to real-   │
                                              │ world side effects   │
                                              └──────────────────────┘
```

**TB-1 — Browser → Server.** Nothing from the client is trusted, including
`projectId`. The client sends a project *key*; the server resolves it to a project
the authenticated user actually belongs to. Server Actions and Route Handlers both
run `requireTenant()` before any work.

**TB-2 — Server → Database.** The application never issues an unscoped tenant
query. `withTenant()` opens a transaction, stamps `app.user_id` / `app.org_id` /
`app.project_id` into the session via `set_config(...)`, and RLS policies read
those. The app connects as `app_server`, a role created with `NOBYPASSRLS`.

**TB-3 — Server → Provider.** Only `src/providers/*` may hold a provider client.
Requests carry a per-run timeout, a retry cap, and an idempotency-ish run-step id.
Headers are never logged.

**TB-4 — Provider → Server.** Model output is hostile-by-default. It is stored
verbatim as an immutable message for auditability, but any *structured* portion
(proposed actions, review verdicts) must survive `Zod.safeParse` or it is discarded
and recorded as a malformed-output audit event.

**TB-5 — Proposed action → Real world.** A model can only ever *propose*. The
`approvals` table is the sole path from proposal to execution, and every execution
writes an audit row before and after.

## 4. Layering

Dependencies point strictly downward. The ESLint config fails the build on an
upward or sideways import.

```
  src/app          (React Server Components, Server Actions, Route Handlers)
        │  may import: components, domain, lib, types
        ▼
  src/domain       (business rules: projects, tasks, agents, approvals, usage, audit)
        │  may import: db, providers, orchestration, lib, types
        ▼
  src/orchestration (the run state machine)
        │  may import: providers, db, lib, types
        ▼
  src/providers    (OpenAIProvider, AnthropicProvider — the ONLY SDK consumers)
        │  may import: lib, types
        ▼
  src/db           (Drizzle schema, tenant-scoped connection)
        │  may import: lib, types
        ▼
  src/lib, src/types  (crypto, env, errors, logging, result — no upward deps)
```

Rules that fall out of this:

- No React component ever imports `openai` or `@anthropic-ai/sdk`.
- No domain service ever imports a provider SDK type — it imports our
  `AIProvider` interface.
- `src/db/schema` is the single source of truth for table shapes; TypeScript types
  are inferred from it, never hand-written twice.

### Why not a package-per-layer monorepo

Considered and rejected for now — see [DECISIONS.md](DECISIONS.md) D-002. Short
version: one deployable, no second consumer of the domain layer yet, and pnpm
workspace friction buys us nothing that ESLint boundary rules don't already give.
The directory layout is monorepo-shaped, so promoting `src/domain` to
`packages/domain` later is a move, not a rewrite.

## 5. The provider adapter

```ts
export interface AIProvider {
  readonly id: ProviderId;                       // 'openai' | 'anthropic'
  execute(request: AgentRequest): Promise<AgentResponse>;
  stream?(request: AgentRequest): AsyncIterable<AgentEvent>;
  estimateCost?(usage: TokenUsage): Money;
  listModels(): readonly ModelDescriptor[];
}
```

`AgentRequest` is provider-neutral: system prompt, ordered turns, model id,
temperature, max output tokens, timeout, abort signal. Each adapter is responsible
for translating to and from its SDK, normalizing usage counts, and mapping SDK
errors onto our `ProviderError` taxonomy (`rate_limited`, `timeout`,
`invalid_request`, `auth`, `overloaded`, `unknown`) so the engine's retry logic
never has to know which vendor it is talking to.

Cost is computed from a versioned pricing table (`src/providers/pricing.ts`) and
stored in **integer USD micros**, never floats.

## 6. Orchestration engine

A deliberately boring, fixed-length state machine. There is no `while` loop
anywhere in the run path.

```
 submit
   │
   ▼
 [ preflight ]  budget check · rate limit · project + agent resolution
   │            · load ONLY this project's approved context
   ▼
 [ step 1: PRIMARY ]  ──► message(role=assistant, agent=primary)
   │
   ├── review disabled ──────────────────────────────┐
   ▼                                                 │
 [ step 2: REVIEW ]   ──► message(role=reviewer)     │
   │                       verdict ∈ {approve,        │
   │                                  revise, reject} │
   ├── verdict = approve ────────────────────────────┤
   ▼                                                 │
 [ step 3: REVISION ] ──► message(role=assistant)    │   exactly one, ever
   │                                                 │
   ▼                                                 │
 [ step 4: CONSOLIDATE ] ◄───────────────────────────┘
   │  deterministic assembly — no model call
   ▼
 [ action extraction ]  Zod-parse proposed actions → approvals (status=pending)
   │
   ▼
 task.status = completed | awaiting_approval
```

Guarantees:

- `MAX_STEPS = 4`, `MAX_REVISIONS = 1` are constants, checked at every transition.
- A reviewer can never trigger another review. The step kind determines what may
  come next; the model does not choose.
- Whole-run deadline (`RUN_TIMEOUT_MS`, default 180s) plus a per-call deadline.
- Retries: at most 2, only on `rate_limited` / `overloaded` / `timeout`, with
  exponential backoff and jitter, and they consume the run deadline.
- Every step writes a `run_steps` row and a `usage_events` row even on failure, so
  a crashed run still bills and audits correctly.
- Cross-provider review defaults to *the other vendor*: an OpenAI primary gets an
  Anthropic reviewer and vice versa. That is the entire point of `provider = both`.

## 7. Project isolation, concretely

Isolation is not a filter applied at the end. It is a parameter threaded from the
session to the SQL.

1. `requireTenant(projectKey)` verifies session → membership in org → membership in
   project. It returns a `TenantContext` that is the only way to get a DB handle.
2. `withTenant(ctx, fn)` opens a transaction and sets the three session GUCs.
3. Every tenant table carries `org_id` **and** `project_id`, both `NOT NULL`, both
   indexed, even when derivable via a join. Redundant on purpose: it makes the RLS
   predicate a single-table check and makes a missing filter a visible bug rather
   than a silent leak.
4. RLS policies on every tenant table:
   `USING (project_id = app.current_project_id() AND org_id = app.current_org_id())`.
5. Context loading is the highest-risk read in the system, so
   `loadApprovedContext()` takes a `TenantContext` and asserts the returned rows'
   `project_id` matches, throwing `TenantViolationError` if not. Belt, braces, and
   a second belt.

The five seeded workspaces — AccurateBids, KodiScan, BushAndBelly, StressPro,
PartsHunt Pro — are ordinary rows. Nothing about them is special-cased; they are
isolated by the same machinery any future project gets.

## 8. Data model

Full DDL lives in `drizzle/`. Shape and intent:

**Identity & tenancy** — `profiles` (mirrors `auth.users`), `organizations`,
`memberships` (org role), `projects`, `project_members` (project role).

**Configuration** — `agents` (project-scoped: provider, model, system prompt,
sampling, role), `project_context_items` (the approved memory; `pending` items are
never loaded into a prompt), `integration_secrets` (AES-256-GCM ciphertext).

**Execution** — `tasks` → `runs` → `run_steps` → `messages`. Messages are immutable
and are the audit-grade record of what each model actually said.

**Output & control** — `artifacts`, `approvals`, `audit_logs`, `usage_events`,
`spend_limits`, `rate_limit_buckets`.

Money is `bigint` micros. Tokens are `integer`. Timestamps are `timestamptz`.
Enumerations are Postgres enums so the database rejects nonsense the app forgot to.

## 9. Request lifecycle (submit a task)

```
POST (Server Action) createTask
  → Zod parse
  → requireTenant(projectKey)               ← membership check
  → budget preflight (spend_limits vs usage_events)
  → rate limit bucket check
  → INSERT tasks (status=pending)
  → audit: task.created
  → return taskId

POST /api/tasks/:id/run
  → requireTenant + ownership re-check       ← never trusts the caller
  → INSERT runs (status=running)
  → engine.execute(...)                      ← the state machine above
      per step: provider call → INSERT run_steps, messages, usage_events
  → action extraction → INSERT approvals (pending)
  → UPDATE tasks status
  → audit: run.completed | run.failed
```

The run is triggered by an explicit second call rather than inline in the create
action so that a slow provider never holds a form submission open, and so retry
semantics live in one place.

## 10. Security posture

Summarized here, detailed in [SECURITY.md](SECURITY.md).

- Secrets: envelope-style AES-256-GCM at rest with a versioned key; plaintext keys
  exist only in process memory during a provider call.
- Logging: structured, with a redaction allow-list. Authorization headers, API
  keys, and full prompt bodies are never logged — prompts live in the DB where they
  are access-controlled, not in log aggregation.
- Model output rendering: plain text nodes only. No `dangerouslySetInnerHTML` in
  any message-rendering path.
- Rate limits: per user, per project, per provider. Spend limits: per project, per
  period, checked before the first token is spent.
- Least privilege: the app's DB role is `NOBYPASSRLS`; the Supabase service-role
  key is used for nothing in the request path.

## 11. Testing strategy

| Layer | Tool | What it proves |
|-------|------|----------------|
| Pure logic — pricing, policy, action parsing, crypto | Vitest | Cost math, loop bounds, malformed-model-output handling, encrypt/decrypt round-trip and tamper detection |
| Orchestration | Vitest + fake providers | The state machine cannot exceed its step budget, handles reviewer verdicts, and records usage on failure |
| Tenancy | Vitest integration against a real Postgres | A query with project A's context cannot see project B's rows — the test that matters most |
| Critical flow | Playwright | Sign in → select project → submit task → see stored response |

Fake providers (`tests/support/fake-provider.ts`) implement `AIProvider`, so the
engine is tested without a network call, deterministically, including the
adversarial cases: a model that emits a prompt-injection payload, a model that
proposes a `git_commit`, a model that returns malformed JSON.

## 12. What Phase 1 delivered vs. what is deferred

Delivered: auth, org/project management with isolation, agent configuration, task
creation, both provider adapters, the full review→revision→consolidation engine,
immutable message history, usage and cost accounting, hash-chained audit log,
approval records for proposed actions, and the dashboard/task/usage/audit screens.

Deferred: artifact binary storage in Supabase Storage (records and text artifacts
exist; blob upload is stubbed), approval *executors* (the queue records and decides;
no executor is wired to a real side effect yet — by design), the MCP server, and
repository integrations. See [ROADMAP.md](ROADMAP.md).
