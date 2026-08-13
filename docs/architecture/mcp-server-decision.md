# MCP server + API-token authentication decision

**Status:** Accepted (Phase 5 foundation)
**Date:** 2026-08-13

Phase 5 (ROADMAP.md) exposes the hub's own capabilities over the Model Context
Protocol so external clients can drive it. This record fixes the authentication
model before any token surface is built, because an API token is a **new way into
the system** and its identity binding is exactly the cross-tenant boundary the rest
of the architecture (ARCHITECTURE.md §3, RLS in `src/db/rls.sql`) exists to protect.

## Token shape and custody

- A token is minted for exactly one `(org, project)` by a **project admin**.
- Wire form: `kmcp_<base64url(32 random bytes)>`. The raw secret is shown **once**,
  at mint, and never stored.
- Stored in `api_tokens`: a SHA-256 **hash** of the secret (unique), a short
  non-secret `prefix` and `last_four` for identification in listings, `name`,
  `created_by`, `scopes`, `created_at`, `last_used_at`, `revoked_at`, and an
  optional `expires_at`. The plaintext secret is never persisted, logged, or
  returned after mint.

## Identity binding

A resolved token authenticates as its **minting admin (`created_by`) within its one
project**. RLS requires a `app.user_id` GUC, and binding to a real member keeps every
existing project-role and RLS check meaningful: a token can never do more than that
admin can do in that project, and `scopes` narrows it further.

The alternative — a dedicated synthetic service-principal user per token — is cleaner
conceptually but requires provisioning synthetic `profiles`/`project_members` rows and
new RLS provisioning policies, a much larger blast radius. It is deferred; the
bind-to-creator model is the safe Phase 5 choice and is forward-compatible with it.

## Resolution before tenant context (the only RLS bypass)

A token must be resolved to `(org, project, user)` **before** a `TenantContext` exists,
and `api_tokens` is itself RLS-scoped by `(org, project)` — the same chicken-and-egg the
identity-resolution reads in `src/db/system.ts` face. Resolution therefore runs through a
single fixed `SECURITY DEFINER` function, `app.resolve_api_token(token_hash)`, that
returns the bound identity for a row that is **not revoked and not expired**, or no row.
This mirrors the existing `app.adopt_placeholder_profile` precedent: a narrow, auditable,
app-invocable definer function is the sanctioned bypass; nothing else reads `api_tokens`
out of tenant scope.

After resolution, **all** tool work runs under `withTenant({ userId: created_by, orgId,
projectId })`. RLS governs every real read and write, so cross-project isolation is
enforced by the same net as the rest of the product — proven by the Phase 5 exit test.

## Tools and guarantees

- Read tools: `list_projects`, `get_task`, `search_messages`, `get_usage`.
- Write tools: `create_task`, `submit_run` — each calls the **same domain functions** as
  the UI (`createTask`, `enqueueRun`). Anything requiring approval lands in the approvals
  queue exactly as a UI-initiated action would. **No tool exposes an approval bypass**, and
  a token cannot approve.
- Every tool call is tenant-scoped and passes through the existing `consumeRateLimit`
  limiter, keyed by token.
- `search_messages` / `get_task` cannot cross the token's project; a request for another
  project's resource returns not-found, never another tenant's data.

## Exit criteria (ROADMAP Phase 5)

An MCP token scoped to one project cannot read another project's task — proven by test
against the RLS-enforcing database matrices.
