# Legacy migration attestation DRAFTS — INACTIVE

Files in this directory are **unsigned drafts for owner review only**. They are **never loaded by production
verification** and carry no signing authority. The G-Backup-A2 verifier only consumes an explicit, validated
**trusted attestation bundle** (with a trusted public-key store) — never an arbitrary JSON file from the repo.

Until the owner completes the offline signing ceremony (see `docs/g-backup-a.md`) and a **signed** attestation
is committed under a separate authorization, the detector continues to classify the affected migration as
`HISTORICAL_HASH_MISMATCH` (fail-closed).

- `0004_knowledge_k1.evidence.json` — structural evidence manifest (no SQL/DB contents).
- `0004_knowledge_k1.attestation.draft.json` — **UNSIGNED** attestation payload + the exact bytes/hash the
  owner must review and sign offline.
