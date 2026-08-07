# Phase 2 — Cross-provider review hardening

Status: complete on protected main after PRs #13–#21 (2026-08-07).

## Completion evidence

- Recorded approve/revise/reject/malformed/ambiguous transcripts pin the fixed state machine and deterministic consolidation.
- Strict v2 review parsing validates bounded, unique claim anchors and fails malformed output closed.
- The task view renders primary, findings, optional revision, immutable reviewer identity, and execution-time rubric provenance side by side; legacy records disclose unavailable provenance.
- Migration `0057_reviewer_rubric` adds nullable `agents.review_rubric` plus the PostgreSQL `octet_length(review_rubric) <= 8192` check, with no data rewrite.
- Rubrics are admin-only, reviewer-only, byte-bounded, canonicalized for LF line endings, and SHA-256 domain-separated with `review-rubric/v1\0`.
- Exit verification: typecheck and production build passed; repository-native secret scan passed; 96 focused Phase 2 tests passed; required CI security, migration-integrity, static, fresh-current DB, and accepted-legacy DB gates passed on each final implementation PR.
- No staging/production deployment, persistent database migration, cloud infrastructure mutation, secret change, receipt/snapshot creation, or paid-provider call was performed.

## Goal and user-visible outcome

Make cross-provider review inspectable and stable. A task reviewed by the other provider must show the primary response, reviewer judgment, optional revision, and final result with enough attribution for an operator to understand what was challenged and what changed.

The fixed workflow remains `primary → review → at most one revision → deterministic consolidation`. Review output may select `approve`, `revise`, or `reject`; it may never create a loop or authorize an external action.

## Existing foundation

- Typed `approve` / `revise` / `reject` verdicts and `critical` / `major` / `minor` issues are parsed at the provider trust boundary and stored in `run_steps.verdict_detail`.
- The task page renders verdict, issue severity, and reviewer-provider provenance.
- OpenAI and Anthropic streaming is wired through the engine and an authenticated SSE route; persisted results do not depend on the observational stream.
- Revision is capped at one and consolidation is deterministic.

## Delivered architecture

1. **Golden transcript contract.** Replay checked-in, inert provider transcripts through the real engine and pin step order, verdict, issue parsing, revision count, and consolidated output. Fixtures contain no credentials and make no network calls.
2. **Claim anchors.** Extend the internal review issue value object with bounded primary-response anchors and a stable claim identifier. Validate all model-provided anchors; an absent or invalid anchor remains visibly unlinked rather than guessed.
3. **Reviewer rubric.** A bounded, server-controlled rubric is part of reviewer configuration and canonical effective-prompt identity; owner-approved migration 0057 implements storage and the byte constraint.
4. **Comparison/provenance view.** Render primary, review, and revision side by side. Link issues to claim anchors and label each surviving sentence as unchanged-primary or revised. Never imply semantic authorship that cannot be deterministically established.

## Data and API impact

- Golden transcripts: test fixtures only; no runtime data change.
- Claim anchors/provenance: prefer the existing JSON `verdict_detail` column and internal types. No SQL change is expected for the first claim-anchor increment.
- Configurable rubrics: likely a new bounded reviewer-agent field and migration. Exact storage, limits, and edit authority require owner approval before SQL is created.
- SSE event names and payloads remain backward compatible. A later comparison UI may consume already-persisted steps; no new public API is currently required.

## Semantics and security boundaries

- `approve`: no revision; preserve the primary response and show the review.
- `revise`: exactly one primary-provider revision using reviewer feedback.
- `reject`: no automatic retry or alternative action; surface caution and the rejection.
- All provider text, rubric-derived text, issues, and anchors are untrusted and schema-validated with strict size/count bounds.
- Reviewer provenance comes from the pinned run/step agent and provider, never model-authored metadata.
- Streaming stays observational: partial text cannot become the durable result, bypass validation, or trigger a retry after an ambiguous remote outcome.
- Review never creates or executes an approval, broker action, deployment, or other external side effect.

## Testing strategy and acceptance criteria

- Golden fixtures cover approve, revise, reject, malformed issues, and a failed/ambiguous review without external calls.
- Parser tests cover severity bounds, claim anchors, malformed JSON, unknown fields, count limits, and injection-shaped strings.
- Engine tests prove fixed step order, one-revision maximum, deterministic consolidation, and checkpoint/replay stability.
- Integration tests prove structured detail and reviewer provenance persist tenant-scoped.
- UI tests prove side-by-side attribution, issue-to-claim navigation, unlinked-issue disclosure, and streaming fallback.
- Phase exit: a `both` task renders primary, review, optional revision, and final result side by side with trustworthy attribution, while golden transcripts pin the state-machine behavior.

## Proposed PR sequence

1. **Golden review transcripts** — fixtures and replay tests; no runtime or schema change.
2. **Claim-anchor contract** — internal types, prompt protocol, parser, and tests using existing JSON storage.
3. **Claim persistence proof** — tenant-scoped integration coverage and backward compatibility for historical details.
4. **Review comparison UI** — side-by-side responses, severities, anchors, and reviewer provenance.
5. **Reviewer rubric configuration** — owner-reviewed schema migration, server actions, prompt identity, authorization, and UI.
6. **Phase 2 exit suite/docs** — end-to-end recorded flow, accessibility/security review, and roadmap status.

The owner approved dedicated reviewer-only storage, an 8192 UTF-8 byte limit, and workspace-admin-only editing before migration 0057 was authored.
