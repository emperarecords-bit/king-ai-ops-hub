# King AI Operations Hub

A single control plane for delegating work to **OpenAI** and **Anthropic** models
across five strictly isolated project workspaces — AccurateBids, KodiScan,
BushAndBelly, StressPro, PartsHunt Pro — with cross-provider review, per-project
memory, human approval gates, exact cost accounting, and a tamper-evident audit
trail.

**This is a standalone product.** It shares no code, data, or credentials with
AccurateBids or any other application.

## How a task flows

```
you submit a task ──► primary model answers ──► the OTHER vendor reviews it
                                                        │
              one revision (max) ◄── verdict: revise ◄──┤
                      │                                 ├── approve / reject
                      ▼                                 ▼
                consolidated result (deterministic — no third model call)
                      │
                      ▼
    any proposed action (commit, deploy, email, …) ──► YOUR approval queue
                                              nothing executes without you
```

Loops are structurally impossible: the engine is a fixed 4-step state machine,
not a conversation loop. See [ARCHITECTURE.md](ARCHITECTURE.md) §6.

## Stack

Next.js 16 · TypeScript 5.9 (strict) · PostgreSQL 17 · Supabase Auth ·
Drizzle ORM · Zod 4 · OpenAI SDK v6 · Anthropic SDK · Vitest 4 · Playwright ·
Tailwind 4 · Docker for local Postgres.

## Local setup

Prereqs: Node ≥ 20.9, Docker Desktop, a Supabase project (free tier is fine —
it is used for **auth only**; all data lives in your Postgres).

```bash
git clone <this repo> && cd king-ai-ops-hub
npm install

# 1) Environment
cp .env.example .env.local
#    Fill in: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#    OPENAI_API_KEY, ANTHROPIC_API_KEY,
#    APP_ENCRYPTION_KEY  (generate: openssl rand -base64 32)

# 2) Database (Docker Postgres on port 5433)
npm run db:up
npm run db:generate     # emit SQL from the Drizzle schema (first time / schema change)
npm run db:migrate      # apply migrations + RLS + append-only triggers + app role

# 3) Seed the org, the five workspaces, default agents, spend limits
npm run db:seed
#    Tip: SEED_OWNER_EMAIL=you@example.com npm run db:seed
#    then sign UP in the app with that same email.

# 4) Run
npm run dev             # http://localhost:3000
```

Sign up with the seeded email, pick a workspace, submit a task.

## Quality gate

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint incl. layer-boundary rules
npm run test        # vitest — unit + tenancy integration (needs db:up + db:migrate)
npm run test:e2e    # playwright — needs E2E_EMAIL / E2E_PASSWORD of a seeded user
```

The tenancy integration suite is the one that proves the core promise: with a
project-A-scoped connection, `select * from tasks` **with no WHERE clause**
returns only project A's rows, and history tables reject UPDATE/DELETE outright.
It skips with a loud warning if the local database isn't up.

## Repository map

```
src/
  app/            screens & server actions (login, projects, dashboard, tasks,
                  approvals, artifacts, agents, providers, usage, audit)
  components/     shared presentational pieces (model output = text nodes, always)
  domain/         business rules: auth guard, tasks, runner, agents, approvals,
                  artifacts, usage & rate limits, audit, integration secrets
  orchestration/  the 4-step run state machine + prompt assembly + action extraction
  providers/      OpenAIProvider, AnthropicProvider, pricing (the ONLY SDK imports)
  db/             Drizzle schema, tenant-scoped connection, RLS SQL
  lib/            env validation, crypto, money, errors, logging
  types/          shared domain & provider contracts
scripts/          migrate, seed, secret key rotation
tests/            unit / integration (tenancy!) / e2e
drizzle/          generated migrations
```

Docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) ·
[ROADMAP.md](ROADMAP.md) · [DECISIONS.md](DECISIONS.md)

## Security posture (short version)

- Provider keys: server env only; the module that reads them fails the build if
  a client component imports it.
- Isolation: every tenant table carries `org_id` + `project_id`, RLS enforced,
  app role is `NOBYPASSRLS`, and the client can only ever name a project *key*
  that is resolved against its own memberships.
- Model output: untrusted, Zod-gated, rendered as text. Proposed actions become
  pending approvals — there is no execution path, by construction, until the
  Phase 3 executors land behind the approval gate.
- History: `messages` and `audit_logs` are append-only (triggers) and the audit
  log is hash-chained per org.
- Spend: monthly per-project limits enforced before the first token, exact
  integer micro-USD accounting, per-user and per-project run rate limits.

Read [SECURITY.md](SECURITY.md) before touching providers, orchestration,
approvals, or the schema.

## E2E setup

Create a user in the app (or Supabase dashboard), make sure the seed linked it
to the workspaces (same email), then:

```bash
E2E_EMAIL=you@example.com E2E_PASSWORD=... npm run test:e2e
```

## Production notes

- Use the Supabase **session pooler** string for `DATABASE_URL` with a dedicated
  `app_server` role (the RLS migration creates it — change the dev password!).
- `DATABASE_MIGRATION_URL` keeps DDL rights out of the running app.
- Set real spend limits per project before inviting the models to do real work.
