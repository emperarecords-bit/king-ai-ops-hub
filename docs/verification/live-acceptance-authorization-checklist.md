# VER-002 — authorization checklist for the three remaining live acceptance gates

> **STOOD DOWN 2026-11-14 — this is a record, not live status.** VER-002 is parked by owner
> decision. None of the three gates below has been authorized, provisioned, or run since this was
> written, and nothing here is a standing instruction to run one. It is kept because it is the only
> written account of what each gate needs and what it costs, which is expensive to re-derive.
> Every fact below is frozen as of `ecf0456` — read the live state before acting on any of it.

Status as of 2026-11-12, `main` @ `ecf0456`. Nothing here has been provisioned, enabled, or run.
This document is what the owner needs to read, decide, and hand back so all three can be executed in
one pass.

**Headline: only one of the three costs money, and it costs cents.** Gate B item (b) and the §7
UID-split both run on hardware already in hand and need no bucket, no cloud account, and no spend.
The earlier framing that all three were blocked on "disposable-bucket authorization" was wrong — it
was true of PR-5 only.

| Gate | Needs provisioning? | Spend | Host | Code to write |
|---|---|---|---|---|
| **PR-5** S3 exclusive-writer acceptance | **Yes** — 1 disposable AWS bucket + 1 scoped key | **< $0.01** | any | **None — suite is already merged** |
| **Gate B (b)** trickling PUT past `T_url` | No | $0 | local | ~1 integration test |
| **§7** Linux UID-split | No | $0 | Linux container | ~1 acceptance script (stage 1 only) |

---

## 1. PR-5 — S3 provider acceptance (§4.7)

### What already exists

The suite is **written and merged**; this is an authorize-and-run step, not a build step.

- `tests/integration/verification-s3-acceptance.int.test.ts` — the live harness
- `tests/support/s3-acceptance.ts` — the scenario logic
- `tests/unit/verification-s3-acceptance-offline.test.ts` — the same logic against a simulated
  provider, already green in CI

It is strict opt-in and **fails loudly rather than skipping** once opted in: endpoint and bucket are
validated against an approval allow-list *before* the credential is ever put into the store
(`validatePrerequisitesOrFail`), the endpoint must be HTTPS, every request is counted against a
budget with a reserved cleanup allowance, all keys go under one random per-run prefix, and `afterAll`
deletes what it created and **asserts the prefix is empty** or fails the suite.

Coverage: PG1 (create-only + second create rejected), PG1-concurrent (exactly one create wins), PG2
(byte-exact round-trip), PG5 (adapter guard + provider conditional write), N1/P1 (`Content-MD5`),
N2/P2 (`x-amz-content-sha256`), and DIAG-A/B/C checksum diagnostics.

Budget ceiling, hard-coded: **60 requests, 30 MB** combined up+down.

### Bucket to create

| Setting | Value | Why |
|---|---|---|
| Provider | **AWS S3** | §4.0 pins AWS as the only target; see the Tigris caveat below |
| Name | e.g. `king-hub-ver002-pr5-acceptance` | disposable, single purpose |
| Region | e.g. `us-east-1` | must match `VER_S3_REGION` |
| Versioning | **OFF** | §4.4 option (A) conditional-create; versioning on switches the design to option (B) version pinning |
| Object Lock | **OFF** | the suite deletes what it creates; a lock makes its own cleanup assertion fail |
| Block Public Access | **ON** (all four) | — |
| Lifecycle rule | expire current objects after **1 day** | belt-and-braces if cleanup ever fails |

IAM key scoped to this bucket **only** — no wildcard resource, no access to any other bucket:

```
s3:PutObject, s3:GetObject, s3:DeleteObject   on arn:aws:s3:::<bucket>/*
s3:ListBucket                                 on arn:aws:s3:::<bucket>
```

`ListBucket` is required — cleanup uses it to prove the prefix is empty.

### Env vars (exact names, all seven required)

```bash
VER_S3_ACCEPTANCE=1
VER_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
VER_S3_APPROVED_ENDPOINT=https://s3.us-east-1.amazonaws.com
VER_S3_BUCKET=king-hub-ver002-pr5-acceptance
VER_S3_APPROVED_BUCKET=king-hub-ver002-pr5-acceptance
VER_S3_REGION=us-east-1
VER_S3_ACCESS_KEY_ID=<scoped key id>
VER_S3_SECRET_ACCESS_KEY=<scoped secret>
```

The `APPROVED_*` pair is a **typo guard, not a second authority** — the suite refuses unless
`ENDPOINT == APPROVED_ENDPOINT` and `BUCKET == APPROVED_BUCKET`. It stops a fat-fingered bucket name
from pointing a live run at something real; it does not substitute for your approval.

These are deliberately **not** the Hub's own `S3_*` / `AWS_*` names, so the run cannot silently
inherit the Fly/Tigris production credentials.

### Command

```bash
npx vitest run tests/integration/verification-s3-acceptance.int.test.ts
```

### Caveat from the one prior live run (2026-09-22, Tigris)

N2 (payload-hash) verified fully. **N1 (`Content-MD5`) verified only partially** — Tigris's MD5
check is non-atomic, so `Content-MD5` is not a safe non-persistence gate there. §4.0 pins AWS S3 as
the only target and explicitly disclaims portability, so **an AWS run is what would actually flip the
gate.** Expect N1 to behave differently on AWS than it did on Tigris; that difference is a result,
not a failure.

### What a green run does and does not authorize

Green = the §4.7 enforcement claims may stop saying "intended, unverified". It does **not** flip
`VERIFICATION_RUNNER_UPLOAD_S3_ENABLED`. That flag is a separate, explicit config change on a named
environment and is not part of this run.

### Owner decisions needed

1. Create the bucket + scoped key as specified above? (**or** nominate an existing disposable bucket)
2. Region and bucket name.
3. Who creates the IAM key — you in the console, or do you want the exact CLI commands to run?

---

## 2. Gate B item (b) — a trickling PUT landing after `T_url`

### This needs no bucket and no spend, and the reason matters

The design wrote item (b) against a **presigned direct-to-S3 PUT**, where the hazard is that S3
evaluates presign expiry at request *start*. **That is not what was built.** The as-built upload path
is a **Hub-proxied streaming PUT**:

```
PUT /api/p/{projectKey}/verification/uploads/{grantId}
```

The Hub is the receiver, so the property can be demonstrated against a **local Hub with
`STORAGE_DRIVER=local`** — no S3, no bucket, no cloud account, no spend.

The hazard transposes exactly, and the code says so in its own words:

- `src/domain/verification/upload-grant.ts:278` — expiry is checked **once**, before streaming
  begins (`const expired = now.getTime() > Date.parse(grant.expiresAt)`).
- `src/domain/verification/ports.ts:110` — the `deadline` handed to `writer.stage()` bounds only an
  **internal publish retry**, not the inbound body read.
- `src/app/api/p/[projectKey]/verification/uploads/[grantId]/route.ts` — `bodyChunks()` loops
  `reader.read()` with **no wall-clock bound**.
- `src/domain/verification/upload-grant.ts:36` — `DEFAULT_MAX_UPLOAD_MS`, commented
  *"RECORDED ONLY — nothing enforces it; never a reclaim trigger."*

So nothing in application code bounds a single PUT's total duration. `DEFAULT_GRANT_TTL_MS` is 5 min
and governs only when an upload may **start**.

### What to demonstrate

Request a grant, then trickle the body slower than the TTL and show the object still lands after
`expiresAt` has passed — confirming expiry is not a deadline, and therefore that timed reclamation
must stay off (which is what PR-6 already implements).

The body must be exactly the declared `Content-Length` and under the 25 MB per-artifact cap, sent
slowly — e.g. 64 KB total at 1 KB every 10 s ≈ 10.7 min, well past a 5 min TTL (or override `ttlMs`
to shorten the run).

### The one thing worth measuring, not assuming

Whether anything **upstream** kills it. Node's HTTP server has a default `requestTimeout` of 300 s,
which — unlike an idle timeout — *is* a total-duration bound. Nothing in this repo configures or
disables it (`next.config.*` and `fly.toml` set no request timeout). Two possible outcomes, both
useful:

- **It is not aborted** → item (b) is demonstrated as written; Gate B's reasoning holds; timed
  reclamation stays disabled.
- **It is aborted at a hard wall-clock** → that is a **candidate for the hard-deadline mechanism
  Gate B says is unresolved**, and is the more valuable result. It would need its own acceptance
  (a trickling PUT must be *killed*, not merely time out on idle) before any timed reclamation
  could be built on it.

Either way, record the measured wall-clock at which the connection dies, if it does.

### Setup

Disposable DB (the repo's `assert-disposable` harness; **not** the shared `king_ai_hub`), plus:

```bash
STORAGE_DRIVER=local
VERIFICATION_RUNNER_MASTER_SECRET=<≥32 chars, local only>
VERIFICATION_RUNNER_KEYS_ISSUANCE_ENABLED=1
VERIFICATION_RUNNER_MACHINE_AUTH_ENABLED=1
VERIFICATION_RUNNER_UPLOAD_ENABLED=1
# VERIFICATION_RUNNER_UPLOAD_S3_ENABLED stays 0 — local driver, not S3
```

### Owner decisions needed

1. Authorize writing one new integration test plus running a local Hub against a disposable DB.
2. Confirm the local-driver substitution is acceptable as the demonstration of item (b) — my read is
   that it is *more* faithful than a presign test, because it exercises the path that actually
   exists. Say so if you want it done against S3 instead, which would make it depend on §1.

---

## 3. §7 item 3 — Linux UID-split acceptance

### Why it cannot run here

`probeIsolation` (`services/verification-runner/src/harness/isolation.ts`) can **never** report
`enforced: true` on win32 — `child_process` has no `uid` option there, and the probe says so in its
gap list rather than pretending. This box is Windows 11, so this gate needs a Linux host. A local
Docker container is sufficient; Docker is already installed. **No spend either way.**

### What §7 item 3 requires

Beyond "the harness ignores a forged `results.json` in the checkout", a probe running **as the
execution uid** must be shown to:

1. be unable to **write** the harness result sink (mode `0700`, owned by the collector uid),
2. be unable to **read** the collector's env/secrets,
3. be unable to **`ptrace`** the collector,
4. have **network egress blocked** unless the catalog declares the check needs it.

### The honest gap to close in the run

`--sandboxed` and `--egress-denied` are **operator declarations**. The runner records them and fails
closed without them, but it does not *create* those conditions. So the acceptance must **independently
construct and verify** them — a container with `--network none`, a `ptrace_scope` barrier — and not
take the flag's word. Only `separateExecutionUid` is genuinely checked (execution uid present, POSIX,
and ≠ the collector's uid).

### Setup

```bash
# inside a Linux container, run as root to set up, then drop
useradd -r -M -s /usr/sbin/nologin hub-exec     # execution uid
useradd -r -M -s /usr/sbin/nologin hub-collect   # collector uid
install -d -m 0700 -o hub-collect -g hub-collect /var/lib/hub-verify/sink
chown -R hub-exec:hub-exec /work/checkout        # checkout writable by exec only
```

### Commands — stage 1 only, and that is the whole gate

All four properties above are **stage-1 (harness) facts**. Stage 1 takes no Hub credential at all by
design, so this gate needs **no Hub, no network, and no staging flags**:

```bash
# stage 1 — harness. No Hub credential in this stage, by design.
king-verification-runner harness \
  --contract <contractId> --checks unit,lint \
  --catalog-version <v> --catalog-digest <sha256> --catalog-dir /opt/hub-catalog \
  --checkout /work/checkout --sink /var/lib/hub-verify/sink \
  --execution-uid "$(id -u hub-exec)" --sandboxed --egress-denied
```

Then, as `hub-exec`, run the four negative probes against the sink, the collector's `/proc/<pid>/environ`,
`ptrace`, and egress — and assert each is denied.

**Do not plan on `attest --dry-run` for this gate.** I checked: `runAttestation` fetches the contract
from the Hub *before* the dry-run branch (`attest/index.ts:51`), so even `--dry-run` requires a
reachable Hub with machine auth + retrieval enabled and a valid issued runner credential. It also
does **not** sign — `sealEnvelope` runs after the dry-run return — so it would not even exercise the
signing path. Stage 2 therefore belongs to the §9 enablement ceremony, not here.

### Owner decisions needed

1. Linux container on this box, or a GitHub Actions Linux runner?
2. Nothing else — this gate needs no Hub and no flags. (A stage-2 run is a separate authorization,
   bundled with §9.)

---

## Suggested order

1. **Gate B (b)** — free, local, and the cheapest to get a result from. May also hand us the
   hard-deadline candidate Gate B has been waiting on.
2. **§7 UID-split** — free, container-local, stage 1 only, no Hub involved.
3. **PR-5** — the only one needing provisioning; do it last so the bucket's life is short.

## What stays untouched regardless

- Production remains inert: `VERIFICATION_RUNNER_MASTER_SECRET` absent, 89 migrations.
- `VERIFICATION_RUNNER_UPLOAD_S3_ENABLED` stays `0` in every environment.
- No staging/production migration, no deploy, and no `supabase db push`.
- The shared `king_ai_hub` database is never migrated for any of this.

---

## Appendix — measured facts from the 2026-11-12/13 recon pass (no provisioning, no spend)

Recorded before this work was stood down for field-readiness work. Everything here was
read or measured, not inferred. Nothing was run against a real bucket and no bucket exists.

### Tooling on this box
| Thing | State |
|---|---|
| `aws` CLI | **NOT installed** (`which aws` → not found). PR-5 needs it installed, or the bucket made in the AWS console. |
| Docker | present, 29.8.0 |
| Hub Postgres | was **not running**; `docker compose up -d` starts `king-ai-hub-db` on **5433** (db `king_ai_hub`, user/pass `king`) |
| Node | v24.18.0 |

### Gate B (b) — the wall-clock bounds that actually exist
Measured on this box (`new (require('node:http').Server)()`):

| Bound | Value | Configured anywhere in the repo? |
|---|---|---|
| `server.requestTimeout` | **300 000 ms** (total request duration, not idle) | **No** — grep for `requestTimeout`/`headersTimeout`/`keepAliveTimeout` finds nothing outside `node_modules`/`.next` |
| `server.headersTimeout` | 60 000 ms | No |
| `idle_in_transaction_session_timeout` | unset | **No** (only `statement_timeout`, and only in `scripts/db-verify-live-migrations.ts`) |

`DEFAULT_MAX_UPLOAD_MS` is **300 000 ms** — numerically identical to Node's default
`requestTimeout`. So the recorded-but-unenforced T_max and the accidental HTTP bound
coincide, which is why nothing has visibly gone wrong yet.

Three further code facts, all confirmed by reading:

1. **The whole byte-streaming loop runs inside one Postgres transaction.**
   `src/app/api/p/[projectKey]/verification/uploads/[grantId]/route.ts` does
   `withRunner(runner, (tx) => redeemUploadGrant({ grants: createDrizzleUploadGrantStore(tx), … }, …, bodyChunks(req)))`.
   A trickling PUT therefore holds a DB transaction open for its entire duration. Nothing
   sets `idle_in_transaction_session_timeout`, so Postgres will not reclaim it either.

2. **The local writer ignores the deadline entirely.**
   `runtime-adapters.ts` → `async stage(finalKey: string, _opts?: StageOptions)` with the
   comment "Local `link()` is atomic with no internal retry, so a deadline is irrelevant here."

3. **The S3 writer's deadline gates retries only, never the first attempt.**
   `s3-object-store.ts` `putIfAbsent`: `if (i > 0 && opts.deadline && now() > deadline) throw`.
   So on **both** adapters a PUT that started before `T_url` and finishes after it still
   publishes. Gate B item (b)'s claim holds on the production adapter too, not just locally.

**Conclusion for item (c):** the "hard-deadline mechanism" Gate B is waiting on does not
exist, but three *accidental* bounds stand in for it — Node's 300 s `requestTimeout`, the
pool's `connect_timeout`/`idle_timeout`, and whatever the DB does to a long-open
transaction. None is grant-derived, none is recorded in evidence, and none aborts the
staged write cleanly: `requestTimeout` destroys the socket.

### What is NOT built, and was going to be
- No committed launcher exists for the env-gated HTTP integration tests. Nothing in the repo
  references `VER_UP_BASE`, so `tests/integration/verification-upload-grant.int.test.ts`
  self-skips everywhere including CI, and its one prior green run was ad hoc.
- The sanctioned disposable-DB guards are `tests/support/require-disposable-db.ts`
  (`REQUIRE_DISPOSABLE_DB=1`, refuses a DB named exactly `king_ai_hub`) and
  `scripts/ci/assert-disposable.mjs`. Disposable DBs are named `king_ai_hub_p1a_verify*`.
- The Gate B (b) test itself was designed but not written. Intended shape: a domain-level
  test with the real `redeemUploadGrant`, `InMemoryUploadGrantStore` + `InMemoryQuotaStore`,
  a **real** clock and a grant with a ~1.5 s TTL, and a body that trickles for ~3 s —
  asserting the redemption completes, the object lands, the reservation finalizes
  (committed, frees nothing), and `Date.now()` is past `expiresAt` at completion. Plus a
  `node:http` probe for the `requestTimeout` boundary at a scaled-down bound.
