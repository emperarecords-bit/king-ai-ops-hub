# king-verification-runner — VER-002 PR-8 reference external runner

A **reference implementation** of the external runner described in
[`docs/verification/external-runner-design.md`](../../docs/verification/external-runner-design.md).
It produces evidence for a Hub verification contract. It is **not** part of the Hub.

## Why it lives in `services/` and not in `src/`

The Hub is an **adjudicator**: it never runs commands. This package *does* run commands, so it must
never ship inside the Hub image. `services/` is the one tracked tree the
[`Dockerfile`](../../Dockerfile) does not `COPY` into the runtime stage (it copies `src`, `scripts`,
`drizzle`, `public` and config). Putting the harness here is what keeps a command executor out of
the Hub's deployed artifact, while still version-controlling it next to the contracts it consumes.

Trade-off, stated plainly: `eslint.config.mjs` ignores `services/**`, so this package is **not
linted**. It *is* type-checked (the root `tsconfig.json` includes `**/*.ts`), and all of its tests
live in `tests/unit/` so the existing `p1-release-gates` CI jobs run them.

## The two stages, and why they are separate processes

| | Stage 1 — harness | Stage 2 — attestation |
|---|---|---|
| Runs | the untrusted approved commands | signing, upload, submission |
| Holds secrets | **none** | bearer credential + HMAC signing key |
| Writes | per-check records to the sink | nothing in the checkout |
| Reads | the checkout | the **sink only**, plus declared artifact files |

This split is design §2.2–2.3. The checked-out code never enters the stage that holds the secrets,
and the stage that holds the secrets never trusts a file the checkout could have written.

```bash
# Stage 1 — no Hub credential needed at all.
king-verification-runner harness \
  --contract "$CONTRACT_ID" --checks unit,lint \
  --catalog-version 2026-09-21 --catalog-digest "$DIGEST" \
  --catalog-dir ./config/verification-catalogs \
  --checkout /srv/checkout --sink /srv/harness-sink \
  --execution-uid 4001 --sandboxed --egress-denied \
  --run-id "$RUN_ID"

# Stage 2 — secrets from the environment only, never argv.
export HUB_RUNNER_KEY_ID=... HUB_RUNNER_KEY_SECRET=... HUB_RUNNER_SIGNING_SECRET=...
king-verification-runner attest \
  --hub https://hub.example.com --project-key my-project \
  --contract "$CONTRACT_ID" --checkout /srv/checkout --sink /srv/harness-sink \
  --catalog-dir ./config/verification-catalogs \
  --runner-id ci-1 --run-id "$RUN_ID" --attempt-id "$RUN_ID-1" \
  --artifact test-results.json=./test-results.json
```

## What this refuses to do

Every one of these is a hard refusal, not a warning:

- **Run without isolation.** `probeIsolation` requires a distinct execution uid, a declared sandbox,
  denied egress, and an unreachable sink. Missing any of them aborts before a command runs.
  `--allow-unisolated` exists for local development and stamps `isolation.enforced: false` into
  every record; `buildSubmission` then refuses to sign those records unless you *also* pass
  `--acknowledge-unisolated`. There is no path to a signed-but-unisolated result by accident.
- **Use a sink inside the checkout**, where the code under test could forge its own results.
- **Run commands from an unreviewed catalog.** The contract's pinned `(version, digest)` must match
  the local catalog before anything executes.
- **Attest a command that drifted** from the pinned catalog entry.
- **Narrow the contract.** Required checks and artifacts come from the contract; a missing one is a
  refusal here, as it would be a rejection at the Hub.
- **Sign records from another run**, so a stale sink cannot be laundered into a fresh attestation.
- **Submit from a checkout that is not at the pinned commit.**
- **Retry a settled refusal.** 409/410/413/422/507 are never retried; only 5xx and transport errors.

## What a signature does and does not prove

Design §6.4, restated because it is easy to over-read: the HMAC proves **who signed** and that the
**payload was not altered in transit**. It does **not** prove the execution was truthful — a holder
of a valid key can sign false claims. Truthfulness rests on the harness: exit codes and timestamps
are captured by the collector process, and the command catalog is pinned to the contract. The
signature and the harness are complementary; neither alone is sufficient.

## Deviations from the design, and why

1. **Upload is a Hub-proxied PUT, not a presigned PUT to S3.** Design §4.1 chooses a presigned PUT
   with signed `Content-Length`, `x-amz-checksum-sha256` and `If-None-Match: *`. PR-4 as merged
   instead issues a grant whose `uploadPath` is a Hub endpoint that streams the body through and
   enforces cap/size/checksum/create-only server-side. **This client implements what is built.** If
   the direct-to-provider path is ever realised — it is gated on PR-5's acceptance run against a
   disposable bucket — only `attest/submit.ts#redeemGrant` changes.
2. **There is no `requests/assigned` endpoint.** §1 names one; the Hub implements `GET
   …/verification/requests`, which is project-scoped rather than runner-assignment-scoped. The
   client uses what exists and does not pretend to filter by assignment.
3. **Isolation is probed and enforced, not created.** This package does not build a container or
   create a uid. §2.3's controls are the operator's to provide (a CI job that has already made the
   user, a network-less container); the runner's job is to refuse when they are absent. Writing code
   that *claimed* to sandbox itself would be the dangerous option.
4. **`exactOptionalPropertyTypes` is off** in this package's `tsconfig.json`, matching how optional
   deps are threaded through the Hub's own verification modules.

## Not in this PR

- **No end-to-end acceptance run.** Design §7 items 3, 5 and 9 need a Linux host with a real uid
  split and a throwaway S3 bucket. Neither is available here, and §2.3's controls **cannot** be
  enforced on win32 at all — `probeIsolation` reports `enforced: false` on that platform by
  construction. The unit tests cover the refusals and the wire contract; they do not and must not be
  read as proof that isolation works on a given host.
- **No provisioning, spend, or deploy.** PR-8 is code only.
- **No Hub-side change.** Not one file under `src/` or `drizzle/` is touched.
