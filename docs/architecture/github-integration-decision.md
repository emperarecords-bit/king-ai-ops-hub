# GitHub repository integration decision

**Status:** Accepted (Phase 6 foundation — repository-only; live API access is owner-gated)
**Date:** 2026-08-13

Phase 6 (ROADMAP.md) connects a project to a GitHub repository: read file trees and blobs
into project context, and write **only** as branch + pull request. This record fixes the
security model before any GitHub API surface exists, because repository content is an
**injection source** and repository write access is a **consequential capability** — both
sit exactly on the boundaries the platform is built around (SECURITY.md T2, ACTION_TYPES).

## Credential model (owner-gated)

- Access is via a **GitHub App** the owner creates, with least-privilege scopes:
  `contents: read`, `pull_requests: write`, `metadata: read` — nothing else. No PAT, no
  OAuth user token, no org-wide grant.
- The App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) are platform secrets
  entered by the owner into the approved secret store. **They are never stored in the
  database and never handled by repository agents.** Until they exist, the adapter is
  UNCONFIGURED and every method fails closed.
- The per-project binding is a `github_repo_links` row: `(org, project)` → App
  **installation id** + one `owner/repo` + its default branch. The installation id is not
  a secret; the row is ordinary tenant-scoped configuration under RLS, linked and
  unlinked only by a project admin.

## Read path — repo content is untrusted data, subject to approval

Fetched blobs do **not** flow straight into a prompt. A fetched file is imported as a
`project_context_items` row with `status = 'pending'` — the existing approval-gated
context flow — and only an explicitly approved item can be offered to a run. At prompt
time, ALL context items pass through `wrapUntrusted` (src/orchestration/prompts.ts),
which strips embedded delimiter tags and encloses the content in
`<untrusted-context>…</untrusted-context>`; the system prompt states such content is data,
never instructions. Repo content therefore gets the same injection rigor as every other
input, plus a human gate before it is ever visible to a model.

## Write path — branch + PR only, always through the approval queue

There is **no direct write capability** in this phase, and by design there never is a
default-branch write:

- A model can only PROPOSE `git_commit` / `git_push` / `git_pr` actions (already members
  of the closed `ACTION_TYPES` set). Proposals become `approvals` rows with
  `status = 'pending'`; nothing executes without a human decision, and the Phase 3
  executor foundation (off by default, kill-switched) is the only future execution path.
- The pure write policy (`src/domain/github/write-policy.ts`) rejects, statically and
  fail-closed: any action that is not one of the three git actions; any action targeting
  the linked repository's **default branch** (or `HEAD`); any push not paired with a PR
  intent; and any action naming a repository other than the project's linked repo.
  `git_push` directly to a default branch is rejected even if a human approved it — the
  policy is checked at execution planning time, not only at proposal time.

## Exit criterion (ROADMAP Phase 6)

A repo file containing an injection payload produces, at most, a **pending approval** —
never an executed action. Proven two ways:

1. **Engine-level (DB-free):** malicious repo content flows through the real
   `executeRun` as a context item; the provider request proves the content arrived
   wrapped in untrusted delimiters with forged closers stripped, and the engine's output
   is `proposedActions` — data, not effects.
2. **Run-level (DB-gated, CI matrices):** a full runner pass with a provider that "obeys"
   the injection yields an `approvals` row with `status='pending'`, a task in
   `awaiting_approval`, and **zero** `executor_executions` rows.

## Deliberately not in this phase

Live GitHub API calls (App JWT signing, installation-token exchange, REST/GraphQL
clients), webhooks, and any executor registration. Each requires the owner-gated
credentials and its own threat-model/rehearsal round per the Phase 3 exit assessment.
