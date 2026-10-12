# Phase 2E — Governed connector commissioning + GitHub revert: evidence record

Issue #135 ("Finish the AccurateBids release") arc. This record covers the hardening PRs, the two
code-only production releases, the live commissioning of the governed Supabase/Vercel/GitHub write
surface, and the GitHub `revert_commit` canary acceptance. It is a durable companion to the
G-Backup receipt ceremony records; every production mutation below was receipt-gated and verified.

All work builds on the Phase 2 control-surface release **v64** (migrations 0079–0083; the
`supabase_project_links` + `vercel_project_links` tables; write executors deployed-but-disabled),
documented in `docs/operations/phase2-v64-release-evidence.md`.

---

## 1. Hardening PRs

| PR | Fix | Prod release | Source |
|----|-----|--------------|--------|
| #147 | Governed-write bridges anchored the approval task on the first *enabled* agent of any role; `createTask` requires a **primary** agent, so a reviewer-first workspace failed closed with "Invalid input." Fixed to `.find(a => a.enabled && a.role === 'primary')` across the GitHub/Supabase/Vercel bridges. | **v69** | `e73e4f9` |
| #148 | `VercelLiveClient.mutate` unconditionally parsed the response body; promote/rollback return `204 No Content`, so success was mis-reported as `ambiguous`. Added an `allowEmptyBody` option (promote/rollback opt in; redeploy stays strict → a malformed body still throws). | **v71** | `d47e6cf` |

Both were caught by live commissioning, not by the test suite — the exact value of exercising the
real governed path against real providers.

## 2. Governed Supabase commissioning (staging)

- Staging-only `SUPABASE_MANAGEMENT_TOKEN` (Edge R+W + Project Read, scoped to `accuratebids-staging`;
  empirically proven **prod `bidright` unreachable, 403**). `supabase_deploy` added to `EXECUTORS_ENABLED`.
- Deployed `public-docs` to staging `nieqgrehmwlmqxgrakac` via the real Ops Chat Confirm → **v3→v4**;
  the Hub audit `execution.result` content digest equalled the pre-deploy dry-run digest
  (`f3a781ef…`); exactly **one** `supabase_deploy`; **zero** `supabase_sql`.
- `supabase_sql` remains validation/dry-run only (`destructive_irreversible`; blocked at the dispatch
  choke point, no executor) — unchanged.

## 3. Governed Vercel commissioning (staging)

- Staging-only `VERCEL_TOKEN` (empirically staging-reachable, prod `client` project unreachable).
  `vercel_mutation` enabled. Staging link added additively; prod link untouched.
- Proven via the real Ops Chat Confirm: **redeploy** (new non-production deployment, production
  unchanged), **promote**, **rollback** — the staging production pointer round-tripped and was
  restored to its original deployment. The #148 empty-body defect was found and fixed mid-commissioning;
  after v71 the clean promote→rollback cycle reported `succeeded` with no reconciliation.
- Final honest audit: `vercel_mutation` succeeded=3, failed=1 (a preview-promote 422, cause not
  established, fail-closed with no side effect), ambiguous=2 (pre-#148, both reconciled as
  externally-succeeded); `supabase_sql` executions=0. Governance never false-successed or auto-retried.

## 4. Governed GitHub `revert_commit` (#135 gap)

### 4.1 Feature — PR #149 → release v72

`revert_commit` rides the existing `git_pr` action/executor as a new `operation` — **no new DB action
type, no migration**, risk class `external_reversible`. It builds the exact inverse of one landed
commit as a new work branch + PR back into its base, entirely through the GitHub Git Data API — no
local clone, and the default branch is never written.

v1 contract (every pre-write check is a definite gate → `blocked`, no side effect): exact
repo/target-SHA/base-branch/expected-base-head (moved head → blocked); baseline = the target's first
parent; target must be an ancestor of the base head; exact baseline→target tree delta with every
affected leaf compared by **full identity** (path + object SHA + mode + type) — equals-target ⇒
cleanly reverted, equals-baseline ⇒ already reverted (skipped), any third state ⇒ conflict (blocked,
no 3-way merge); a non-blob affected entry ⇒ blocked; all-already-baseline ⇒ no-op (blocked); a
truncated tree fails closed. Writes: `createTree`/`createCommit` mint refless objects; `createRefAtSha`
(policy-gated to a non-default branch) is the first visible side effect; a PR failure after the branch
exists is `ambiguous` + reconciliation, never a blind retry; post-action verification is fail-closed.
Provenance: commit message `Revert <SHA>: <subject>` + the original SHA in the PR body.

A pre-merge review added a base-head **TOCTOU** guard (re-read the base head immediately before the
write; bind `pr.headSha` to the revert commit; re-read the base after PR creation → ambiguous if it
moved). `3571acf` on main → **v72** (code-only; digest `98777b61…`; receipt `rcpt2_ca7c4c14…`,
pending=0; release-command "receipt verified for 0 pending migration(s)").

### 4.2 Canary finding → PR #150 → release v73

The first canary run (disposable repo `emperarecords-bit/hub-revert-canary`, created for this
acceptance) caught a real bug, **fail-closed with zero side effect**: the branch-collision pre-check
used `getCommit(repo, revertBranch)` and only treated **404** as "absent", but GitHub's commits
endpoint returns **422** (not 404) for a non-existent ref — so every fresh revert failed closed at the
guard. The unit-test fake had modeled a 404 for a missing branch (a test-fidelity gap).

PR #150 fixed it: a new `branchHeadSha(repo, branch)` on the **Git Refs API** (`GET /git/ref/heads/{branch}`)
determines absence **by HTTP status, never by body shape** — 404 → null; a malformed 200 without a
valid `object.sha` throws; any other error propagates. The collision check now uses it. The create-ref
422 handling became **evidence-based**: reconcile with a refs lookup — branch absent → definite
failed; at the intended revert commit → ambiguous + reconcile; at a different commit → collision
blocked; reconciliation-read failure → ambiguous; never auto-retried. `12ce09c` on main → **v73**
(code-only; digest `f43bb37b…`; receipt `rcpt2_54039064…`, pending=0; release-command verified 0 pending).

### 4.3 Canary acceptance (on v73) — PASS

Repo `emperarecords-bit/hub-revert-canary`; target `8b997d56…` ("Add canary.txt"); base `main` @
`8b997d56…`; branch `hub/revert-8b997d56`. Driven through the real production Ops Chat; the confirm
payload was verified to bind all four exact values before confirming.

- new work branch `hub/revert-8b997d56` created;
- **exactly one** revert commit `360a78e742…`, single parent = base head `8b997d56…`;
- PR **#1** opened into `main`; `main` **unmodified**;
- revert tree `ef90025d…` is **byte-identical** to the baseline (parent) tree `ef90025d…`;
  `canary.txt` removed on the branch;
- provenance message `Revert 8b997d56…: Add canary.txt (…)`;
- audit outcome **succeeded**; PR #1 **not merged** (the feature is "construct a governed revert
  branch + PR", not automatic default-branch rollback).

**Cancel / no-write case:** a second proposal (`hub/revert-8b997d56-cancel`) was **cancelled** →
"Cancelled — nothing was changed"; no `-cancel` branch exists and the repo still has exactly one PR.

## 5. Production state after this arc

Prod is **release v73** (`12ce09c`, digest `f43bb37b…`), DB unchanged at **84/84** (NO_PENDING; no
Phase 2E change touched schema, migrations, action types, or the confirmation policy). Write executors
are commissioned (`supabase_deploy`, `vercel_mutation`) with staging-scoped tokens; `supabase_sql`
stays off. Rollback target: image `98777b61…` (v72).

## 6. Remaining for #135

1. The real **"Finish the AccurateBids release"** acceptance — under its own explicit production
   authorization, staging-first, and never AccurateBids production as the first real target.
2. Close **#135**.
3. Cleanup (after this evidence lands): the canary repo/branch/link and the stopped fourth worker.
