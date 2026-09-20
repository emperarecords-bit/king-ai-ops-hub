# PR-2 — Machine-auth foundation: implementation brief

Companion to the external-runner plan (#107) and design (§6). **Prep only — nothing here is
implemented, no keys/secrets are provisioned, #107 is not merged, nothing is deployed, and
staging/production migrations remain paused.** This brief pins the credential lifecycle, the
pre-tenant lookup, endpoint permissions, the default-off controls, and the acceptance tests, then
recommends defaults and lists the owner decisions to settle before coding.

## Goal (and non-goals)
Let a CI runner authenticate to **one project** without a personal session, so later slices
(retrieval PR-3, upload PR-4, ingest) can accept a machine caller. PR-2 lands the key model, the
pre-tenant lookup, the `requireRunnerOrTenant` guard, and the signing-key **version + revocation**
checks — and wires the guard onto the **existing** ingest route so a runner no longer needs a
cookie there. **Non-goals:** no retrieval/upload routes (PR-3/PR-4), no runner client (PR-8), no
contract-creation for runners (they can't author requirements). The human session path is unchanged.

Note the **two distinct secrets** (design §6): the **bearer credential** (this PR) authenticates the
channel/tenant; the **HMAC signing key** (already derived per-project from the server-side master)
authenticates the payload. Separate secrets, separate rotation. PR-2 owns the bearer lifecycle and
adds signing-key **version** handling; it does not change the master derivation.

## 1. Credential lifecycle (exact)
**Storage — `verification_runner_keys` (new table, tenant-scoped, migration + pins bump):**
`id` (keyId, uuid) · `org_id` · `project_id` · `secret_hash` (never the plaintext) · `label` ·
`created_by` · `created_at` · `last_used_at` · `expires_at` (nullable) · `revoked_at` (nullable).

- **Issue:** a **project admin** (human session), behind the default-off issuance gate (§4), calls an
  admin action. Server generates `keyId` (uuid) + a 32-byte random secret (base64url), stores only
  `secret_hash`, and returns `keyId.secret` **once**. Plaintext is never stored or logged.
- **Present:** runner sends `Authorization: Bearer <keyId>.<secret>`.
- **Verify:** look up by `keyId` (§2), constant-time compare `secret` against `secret_hash`, confirm
  **active** = not `revoked_at`, not past `expires_at`. Touch `last_used_at` (best-effort).
- **Rotate:** issue a new `keyId`, run both in parallel, cut CI over, then revoke the old
  (`last_used_at` confirms it is idle first). No downtime.
- **Revoke:** set `revoked_at` → rejected on the very next request.
- **Expire:** optional `expires_at`; a past value rejects.

## 2. Pre-tenant lookup (exact)
Authenticating a machine must **not** require tenant GUCs — they are derived *from* the key, so the
lookup runs before any tenant context exists.

- A `SECURITY DEFINER` function `app.lookup_runner_key(key_id uuid)` owned by a privileged role
  returns **only** `{org_id, project_id, secret_hash, revoked_at, expires_at, signing_key_version}`
  for that `keyId`. `app_server` has **no direct SELECT** on `verification_runner_keys` — the function
  is the only read path, and it exposes nothing else.
- The app verifies the secret, then **builds `TenantContext` from the key's own `org_id`/`project_id`**
  and stamps the RLS GUCs (`app.org_id`/`app.project_id`/… ). From that point every query is
  tenant-scoped exactly as a human session's is.
- Guard **`requireRunnerOrTenant(projectKey, req)`**: runner-credential path (above) **or** the
  existing `requireTenant` human path — never both; neither ⇒ **401**. The resolved tenant's
  `project_id` must equal what `projectKey` resolves to, or **403** (a key for project A cannot act on
  project B).

## 3. Endpoint permissions (matrix PR-2 establishes; enforced by guard + RLS)
| Endpoint | Human session | Runner credential |
|---|---|---|
| Mint runner key (admin action, **new**) | project **admin** only | denied |
| Submit evidence (existing ingest route) | allowed (signature still required) | allowed (via guard) |
| Create contract (existing) | admin/member (viewer 403) | **denied** (runners don't author) |
| Retrieval / upload (PR-3 / PR-4) | — | *not in this PR* |

Enforced twice: in the guard (principal type) and by RLS (GUCs from the resolved principal, never the
payload). Viewer/non-member human behavior is unchanged.

## 4. Default-off controls
- **Credential issuance is default-off:** an enablement flag (recommended: env
  `VERIFICATION_RUNNER_KEYS_ENABLED`, default `0`) gates the mint action; while off it refuses. This
  is the concrete follow-through on the plan correction that "unset master ≠ everything off" — key
  issuance has its **own** gate, independent of the signing master.
- **Ingestion remains master-gated:** an unset `VERIFICATION_RUNNER_MASTER_SECRET` still disables
  signature verification, so even an authenticated runner's evidence is rejected until the master is
  set (the enablement ceremony, PR-9). PR-2 does not set it.
- **Signing-key version + revocation (both paths):** the evidence envelope carries its
  `signing_key_version`; ingest recomputes the HMAC only with currently-valid version(s) and rejects
  an unknown/retired version (`bad_signature_version`) whether the caller authenticated as machine or
  human. A revoked bearer key and a retired signing-key version both reject; unset master disables all
  ingestion.

## 5. Acceptance tests (disposable DB + local stub; gate toggled on only in-test)
1. **Machine auth, no session:** a valid bearer authenticates to the ingest route with **no cookie**;
   an unauthenticated call → 401; a human viewer is still 403 where humans are restricted.
2. **Bearer verification:** wrong secret → 401; unknown `keyId` → 401; expired key → 401; **revoked**
   key → 401 on the next request.
3. **Pre-tenant lookup isolation:** `app_server` cannot `SELECT` `verification_runner_keys` directly;
   the definer function returns only the allowed columns; a key for project A used against project B's
   `projectKey` → 403.
4. **Tenant binding:** GUCs are stamped from the key, not the payload; a cross-project submission is
   rejected by RLS/binding.
5. **Signing-key version + revocation on both paths:** a retired `signing_key_version` is rejected for
   **both** a machine-authenticated and a human-session submission; unset master → ingestion disabled.
6. **Default-off gate:** with `VERIFICATION_RUNNER_KEYS_ENABLED=0` the mint action refuses; on (test)
   it issues, returns the secret once, and stores only the hash (asserted).
7. **Hashing:** the stored value is a salted hash, not the plaintext; verification uses a constant-time
   comparison.

## 6. Recommended defaults
- **Hash:** `scrypt` via Node's built-in `crypto` (**no new dependency**), per-key random salt.
- **Secret:** 32 random bytes, base64url; `keyId` = uuid; credential string `keyId.secret`.
- **Expiry:** none by default (nullable) — rely on revocation + rotation.
- **Issuance gate:** env `VERIFICATION_RUNNER_KEYS_ENABLED`, default `0`.
- **Pre-tenant lookup:** the `SECURITY DEFINER` function (fewer moving parts than a second DB
  connection/role).
- **Signing-key versions:** `v1` remains the only valid version now; add the `signing_key_version`
  field and accept a small configured set.
- **Who mints:** project **admin** only.
- **Migration/pins:** new table (+ function via `rls.sql`) ⇒ a journaled migration and a
  `PRODUCTION_PINS` bump; verified on disposable DBs; **not** applied to staging/prod.

## 7. Owner decisions to settle before implementation
1. **Password hash:** `scrypt` (built-in, recommended) vs **Argon2id** (stronger, adds a dependency).
2. **Who may mint runner keys:** project admin only (recommended) vs org admin as well.
3. **Key expiry policy:** no default TTL (recommended) vs a default (e.g., 90 days) requiring rotation.
4. **Default-off gate shape:** a single env flag (recommended, simplest) vs a per-project setting row
   (finer-grained, more infra).
5. **Signing-key versioning:** confirm `v1` is the sole valid version today, and that adding the
   version field now (accept-set of one) is the intended forward path.
6. **Issuance surface/naming:** the admin action's route/location under the project (e.g.
   `POST …/verification/runner-keys`, admin-only) — confirm the shape before coding.

Once 1–6 are settled (or the recommended defaults accepted), PR-2 can be built on a new branch,
verified on disposable databases, and opened unmerged — still with no provisioning, no deploy, and
staging/prod migrations paused.
