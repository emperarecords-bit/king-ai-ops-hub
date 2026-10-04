# Production rollout closeout — G-Backup gated deploy (2026-10-04)

**Status: COMPLETE — production accepted on release v51.**

This is the dated, durable record of the first production run of the G-Backup coordinated deploy ceremony
(snapshot → sign → publish → gated deploy with the Model A image-identity gate), which advanced production from
migration 69 to 78.

## Canonical production state (accepted)

| Field | Value |
|---|---|
| Source (main) | `d55357a69d8be885ec33dab368379ac08b0a78db` |
| Production release | **v51 — COMPLETE** (accepted) |
| Deployed digest | `sha256:7f4f939a6f23a7cb1fe80ed5d8a6227d82386fdd5916a39691f0fd97f8b97a08` (on all machines) |
| Image ref | `registry.fly.io/king-ai-ops-hub-prod:gbackup-d55357a-prod@sha256:7f4f939a…505a` |
| DB migration count | **78** (latest `0077_chunky_owl`) |
| DB system identifier | `7673854635852591781` |
| Source volume | `vol_vlye16958n6x6ed4` |

### Ceremony artifacts
| Field | Value |
|---|---|
| Snapshot | `vs_Ol883OKeBglnUz7j6qjLp` (created **2026-10-04T14:39:02Z**, retention 30) |
| Deployment nonce | `f3a50c106707d8bdce64017a68f73e4e` |
| Production sign run | `37210276723` (success; production-reviewer approved) |
| Receipt ID | `rcpt2_5072d048735d51939491bb8d0f4bef365a4b97b6660805b11e7f8c74a6a2c2ac` |
| Receipt SHA-256 | `ca2ca4eceefc2cacdab617a0478da9021f89a947df06cd75c33add4b8726e584` |
| Production publish run | `37210847026` (success; create-only write + anonymous read-back + remote re-verify) |
| Public receipt URL | `https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com/v2/production/king-ai-ops-hub-prod/f3a50c106707d8bdce64017a68f73e4e.json` (anon GET 200, ~128 ms) |
| Signing key id | `prod-dbr-2026-08` (public fingerprint `f198a480de5e3948a29af881e35e42c0502ea85fe0b3449e11af094a789d803b`) |

## Verified acceptance (v51)
- Signed digest deployed on all machines.
- G-Backup pre-migration gate **passed**; Model A image-identity (namespace) check **passed**.
- Migrations **0069–0077 applied in order**; RLS applied; **78/78 verified**.
- `/api/health` **green** — process / database / migrations / worker / storage all ok.
- VER-002 upload **disabled** (403; flag absent). fake-provider mode **unavailable** (fence flag absent + Fly runtime present).
- Auth boundary normal (`/` → login). Receipt **anonymously readable** (confirms the prod WORM bucket public-read policy on `/v2/production/king-ai-ops-hub-prod/*`).

## Intermediate failed attempt — preserved as historical evidence (NOT success)
- **Production release v50 — FAILED, before any DDL.**
- Cause: pre-migration gate `verification_failed` / `timeout` — the gate's 2 s receipt-fetch transport timeout was exceeded on the **cold** first fetch from the Fly machine to AWS S3. Receipt was valid/published/readable; a single authorized retry (v51) succeeded on the warm fetch.
- Production remained on v49 throughout v50 (fail-closed; no schema change). v50 is retained in the Fly release history as a failed attempt and must not be rewritten as a success.

## Rollback pair
- **Application:** v49 — image `sha256:38c0438080bd525759fb7a2f6ccd142df5b14993cd7a2dbcabb680e621834331`.
- **Database:** pre-migration snapshot **`vs_Ol883OKeBglnUz7j6qjLp`** (the window's snapshot, taken before migrate).
- **Note:** after migration 69→78, **app-only rollback is insufficient** (DDL + RLS persist). A true rollback restores the DB snapshot (new volume from snapshot → reattach on the DB app) **and** redeploys the v49 image together.

## Follow-up risk (tracked separately)
- **2-second cold-fetch transport timeout** — surfaced as the v50 failure. Tracked in issue
  **[#123 — G-Backup receipt transport timeout hardening](https://github.com/emperarecords-bit/king-ai-ops-hub/issues/123)**
  (evaluate 2000 ms → ~5000 ms, preserve fail-closed, add deterministic delayed-first-fetch tests). **No production
  config change is made as part of this closeout.**

## Unresolved acceptance gap (explicit)
- **Quick/Reviewed UI and review-state surfaces were NOT independently exercised through an authenticated production
  session after v51.** They were accepted on staging and are present in the byte-identical deployed application code
  (`d55357a`; PR #122 added only the production publisher workflow/CLI/test/doc — no app/UI change). This is a
  code-identity assertion, **not** a live production UI test. A live authenticated prod UI smoke (non-billable, no
  provider execution) remains available if desired.
- AWS bucket internals (Object Lock / COMPLIANCE-30d / versioning / lifecycle / IAM scope) are **owner-attested**; the
  public-read policy and create-only write are machine-confirmed by the successful publish + anonymous read-back.
