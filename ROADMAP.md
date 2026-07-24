# Roadmap

Milestones are sized so each one ends with the quality gate green and something
demonstrable. Nothing here is a placeholder commitment — a phase is not complete
until its exit criteria are literally checkable.

## Quality gate (applies to every phase)

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint, incl. layer-boundary rules
npm run test        # vitest unit + integration
npm run test:e2e    # playwright, critical flow
```

Plus: tenant isolation test passes, no secret reachable from a client bundle,
error states handled, docs updated.

---

## Phase 1 — Vertical slice ✅ complete

Sign in → create/select project → submit a task → one provider executes → response
stored immutably → history renders → usage recorded → audit event written.

**Delivered**
- Supabase Auth sign-in/sign-out, cookie sessions, `requireTenant()` guard
- Organizations, projects, project membership; five workspaces seeded
- Agent configuration per project (provider, model, system prompt, sampling)
- Task creation with Zod-validated input
- `OpenAIProvider` and `AnthropicProvider` behind the `AIProvider` interface
- Orchestration state machine: primary → review → one revision → consolidation
- Immutable `messages`, `runs`, `run_steps`
- Token + cost accounting in USD micros, versioned pricing table
- Hash-chained append-only audit log
- Approval records created from Zod-validated model action proposals
- Screens: login, project selector, dashboard, new task, task detail, approval
  queue, artifacts, agent settings, provider settings, usage, audit log
- RLS on every tenant table; cross-tenant read test; Playwright critical flow

**Exit criteria** — all four gate commands green; a task submitted against a
seeded project produces a stored assistant message, a `usage_events` row with a
non-zero cost, and an `audit_logs` row, and none of it is visible from another
project's context.

---

## Phase 2 — Cross-provider review hardening

The engine already runs the review workflow; this phase makes it trustworthy.

- Structured reviewer verdicts (`approve` / `revise` / `reject`) with per-claim
  severity, rendered as a diff-style view against the primary response
- Reviewer rubric configurable per agent
- Consolidation shows provenance: which sentence survived review, what changed
- Streaming (`AIProvider.stream`) wired to the task detail screen via SSE
- Golden-transcript tests: recorded provider responses replayed to assert the
  engine's transitions are stable

**Exit criteria** — a task with `provider = both` renders primary, review, and
revision side by side with attribution, and the recorded transcripts pin the
state machine's behavior.

---

## Phase 3 — Approval executors

The gate exists and records decisions; nothing is wired to a side effect yet. This
is deliberate — executors are the highest-risk code in the product and get their
own phase.

- `executeApprovedAction()`: single choke point, re-reads the approval row, refuses
  anything not `approved`, unexpired, and matching its recorded payload hash
- Executors, in this order: `file_write` (sandboxed to an approved workspace path),
  `git_commit` / `git_pr`, `db_mutation` (dry-run diff first), `deployment`
- Dry-run preview for every executor before the approve button is live
- Rollback record per execution
- Per-executor audit events, before and after

**Exit criteria** — an approved `file_write` writes only inside the workspace root,
a path-traversal payload is rejected with an audit event, and an expired approval
cannot execute.

---

## Phase 4 — Artifacts

- Supabase Storage buckets, one prefix per project, signed URLs only
- Upload from a run step; checksum on write, verified on read
- Versioning and diff view for text artifacts
- Retention policy per project

**Exit criteria** — an artifact produced in project A is not retrievable with a
signed URL request authorized for project B.

---

## Phase 5 — MCP server

Expose the hub's own capabilities over Model Context Protocol so external clients
can drive it.

- Read tools: `list_projects`, `get_task`, `search_messages`, `get_usage`
- Write tools: `create_task`, `submit_run` — every one of them tenant-scoped and
  rate-limited
- No tool exposes an approval bypass; MCP callers land in the same queue
- Per-client API tokens, scoped to a single project, revocable, hashed at rest

**Exit criteria** — an MCP token scoped to KodiScan cannot read an AccurateBids
task, proven by test.

---

## Phase 6 — Repository integrations

- GitHub App install per project, least-privilege scopes
- Read: file tree and blob fetch into project context, subject to approval
- Write: branch + PR only, never direct push to a default branch
- Repo content enters the prompt inside `<untrusted-context>` delimiters and is
  treated as an injection source with the same rigor as any other input

**Exit criteria** — a repo file containing an injection payload produces, at most,
a pending approval; never an executed action.

---

## Deliberately not planned

- Autonomous background agents with no human in the loop
- Any workflow where a model's output selects the next model call without a bound
- Shared context across projects, in any form, including "just for search"

These are excluded on purpose. Re-opening any of them is a change to the product's
core promise, not a feature request.
