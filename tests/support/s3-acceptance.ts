/**
 * Shared VER-002 PR-5 acceptance logic, used by BOTH the strict opt-in live harness
 * (tests/integration/verification-s3-acceptance.int.test.ts) and the offline simulation
 * (tests/unit/verification-s3-acceptance-offline.test.ts). Extracting it means the live harness's
 * key-selection, budget, and cleanup behaviour is exercised against a simulated provider WITHOUT cloud
 * access, so those bugs are caught in CI rather than only when the live run is authorized.
 *
 * The provider guarantees are exposed as INDEPENDENT per-guarantee steps (runPG1…runPG5) so a single
 * guarantee's assertion failure (e.g. PG3 on a provider that accepts a wrong checksum) does not prevent the
 * others (notably PG5) from being evaluated. `runAcceptanceScenarios` remains a sequential convenience
 * wrapper (fails fast) for the positive all-pass path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { signS3Request, type S3Config, type S3ObjectStore } from '@/domain/documents/s3-object-store';

const rawChecksumB64 = (b: Buffer): string => createHash('sha256').update(b).digest('base64');
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const amzDateNow = (): string => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

/** Parse the `<Code>…</Code>` from an S3 XML error body, or null if none. */
export function parseS3ErrorCode(body: string): string | null {
  return body.match(/<Code>([^<]+)<\/Code>/)?.[1]?.trim() ?? null;
}

/** The EXPLICIT allow-list of S3 error codes that DOCUMENT rejection of a wrong `x-amz-checksum-sha256`
 *  VALUE (the checksum header PG3 deliberately corrupts), compared case-insensitively:
 *    - `BadDigest` — the checksum sent did not match what the server computed for the body. This is the
 *      documented MISMATCH semantics PG3 asserts.
 *  DELIBERATELY EXCLUDED:
 *    - `InvalidDigest` documents a MALFORMED/invalid checksum value, not a value that is well-formed but
 *      wrong (the case PG3 probes), so it does not prove mismatch rejection and must NOT count as a pass.
 *    - `XAmzContentSHA256Mismatch` is a PAYLOAD-SIGNING error (the SigV4 `x-amz-content-sha256` request
 *      hash), not a rejection of the checksum header.
 *  Any other code — a malformed-digest error, a payload-signing error, an auth/5xx/unsupported response, or
 *  an unconfirmed/invented code — FAILS CLOSED, even with a 4xx status. Adding a provider-specific code
 *  requires documented mismatch semantics first. Alternative checksum request forms (declared
 *  checksum-algorithm, trailing checksums, Content-MD5) are intentionally left to a separate proposal. */
export const CHECKSUM_MISMATCH_CODES: readonly string[] = ['BadDigest'];
const isChecksumMismatchCode = (code: string | null): boolean =>
  code !== null && CHECKSUM_MISMATCH_CODES.some((c) => c.toLowerCase() === code.toLowerCase());

/**
 * A PRODUCTION-SHAPED verification artifact key factory: keys are `org/<o>/project/<p>/request/<r>/attempt/
 * <a>/<obj>` — the exact shape production uses — under a run-scoped random tenant, so acceptance exercises
 * real key selection (and the `put` verification-key guard) inside the disposable bucket. `prefix` is the
 * run's LIST prefix for cleanup verification.
 */
export function makeAcceptanceKeys(): { prefix: string; key: (attempt: string) => string } {
  const prefix = `org/${randomUUID()}/project/${randomUUID()}/request/${randomUUID()}`;
  return { prefix, key: (attempt: string) => `${prefix}/attempt/${attempt}/${randomUUID()}` };
}

export interface BudgetLimits {
  readonly maxRequests: number;
  readonly maxBytes: number; // upload + download combined
  readonly cleanupReserve: number; // requests reserved so cleanup always fits within maxRequests
  readonly cleanupByteReserve: number; // BYTES reserved so cleanup has a FINITE allowance (never unlimited)
}

/** Live counters. `tripped` latches once a TEST-phase request hit a budget/safety stop (see the fuse). */
export interface FetchStats {
  readonly requests: number;
  readonly uploadBytes: number;
  readonly downloadBytes: number;
  readonly tripped: boolean;
}

export interface BudgetedFetch {
  readonly fetch: typeof fetch;
  readonly enterCleanupPhase: () => void;
  readonly stats: () => FetchStats;
}

/**
 * Wrap a fetch with: a request budget (reserving `cleanupReserve` for the cleanup phase), a combined
 * upload+download byte budget (reserving `cleanupByteReserve`), HTTPS enforcement, and redirect rejection.
 *
 * SAFETY FUSE: when a TEST-phase request hits a budget ceiling OR an unsafe response (non-HTTPS URL, a
 * redirect), the fuse LATCHES (`tripped`) and every subsequent TEST-phase request is refused DETERMINISTICALLY
 * without touching the network — so budget exhaustion or an unsafe configuration STOPS further test traffic
 * rather than repeatedly hammering the provider. The CLEANUP phase is never gated by the fuse: it keeps its
 * reserved allowance (bounded) so cleanup still runs after a test-phase stop. (HTTPS/redirect safety still
 * applies in both phases — the fuse only governs whether further TEST requests are attempted at all.)
 */
export function makeBudgetedFetch(inner: typeof fetch, limits: BudgetLimits): BudgetedFetch {
  let requests = 0;
  let uploadBytes = 0;
  let downloadBytes = 0;
  let cleanupPhase = false;
  let tripped = false;
  const total = (): number => uploadBytes + downloadBytes;
  // Latch the fuse for a test-phase stop; a no-op in cleanup (cleanup is never fuse-gated).
  const trip = (): void => {
    if (!cleanupPhase) tripped = true;
  };
  const fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = String(url);
    // Safety: HTTPS only, in BOTH phases. An unsafe URL trips the fuse.
    if (!u.startsWith('https://')) {
      trip();
      throw new Error(`live acceptance refuses a non-HTTPS URL: ${u}`);
    }
    // Fuse: once tripped in the test phase, refuse further TEST requests without any network call.
    if (!cleanupPhase && tripped) throw new Error('live acceptance halted: budget/safety fuse tripped; no further test requests');
    // Check the request ceiling BEFORE counting, so a request rejected for exceeding the budget does not
    // itself consume budget (the reserved cleanup capacity stays intact even after a failure).
    const ceiling = cleanupPhase ? limits.maxRequests : limits.maxRequests - limits.cleanupReserve;
    if (requests + 1 > ceiling) {
      trip();
      throw new Error(`request budget exceeded (phase=${cleanupPhase ? 'cleanup' : 'test'}, ceiling=${ceiling})`);
    }
    const method = String(init.method ?? 'GET');
    const body = init.body as Uint8Array | undefined;
    const bodyLen = body?.byteLength ?? 0;
    // The byte ceiling for THIS phase. Cleanup keeps a FINITE allowance (maxBytes), not unlimited; the test
    // phase reserves `cleanupByteReserve` so cleanup can still transfer after a test-phase budget failure.
    const byteCeiling = cleanupPhase ? limits.maxBytes : limits.maxBytes - limits.cleanupByteReserve;
    // Reject an oversized OUTGOING body BEFORE calling fetch (never send bytes we cannot afford).
    if (bodyLen > 0 && total() + bodyLen > byteCeiling) {
      trip();
      throw new Error(`outgoing body would exceed the byte budget (received ${total()}, +${bodyLen} > ${byteCeiling})`);
    }
    requests += 1;
    uploadBytes += bodyLen;
    // A redirect under `redirect: 'error'` (and any network failure) REJECTS here rather than returning a
    // 3xx, so the rejection would otherwise bypass the fuse. Trip on it too — a real redirect/network error
    // must halt further TEST requests. The mocked-3xx status check below is kept as defence-in-depth for a
    // simulator that RETURNS a 3xx instead of rejecting.
    let res: Response;
    try {
      res = await inner(u, { ...init, redirect: 'error' }); // never follow a redirect to another host
    } catch (err) {
      trip();
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      trip();
      throw new Error(`live acceptance rejects a redirect (${res.status})`);
    }
    // Count ACTUAL response-body bytes AS THEY ARE CONSUMED into the SHARED counter (do not trust
    // Content-Length; it may be missing). Each chunk is accounted BEFORE the check, so bytes already
    // received — even on a failed or cancelled read — are counted HONESTLY. The check uses the LIVE shared
    // total, so concurrent responses share one budget. HEAD carries no body; its content-length is the
    // OBJECT size (metadata) and must NOT be counted. We consume the original (a clone/tee would deadlock)
    // and rebuild an equivalent Response so the caller can still read it.
    if (method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read(); // a rejected read propagates with bytes already counted
        if (done) break;
        if (value) {
          downloadBytes += value.byteLength; // account as consumed, into the shared counter
          chunks.push(value);
          if (total() > byteCeiling) {
            trip();
            await reader.cancel(); // stop pulling more; the received bytes stay counted (honest)
            throw new Error(`byte budget exceeded (received ${total()} > ${byteCeiling})`);
          }
        }
      }
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return new Response(merged.byteLength ? new Uint8Array(merged) : null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    enterCleanupPhase: (): void => {
      cleanupPhase = true;
    },
    stats: (): FetchStats => ({ requests, uploadBytes, downloadBytes, tripped }),
  };
}

/** Context shared by every acceptance step. Each step tracks the keys it creates (BEFORE sending) so
 *  cleanup can delete exactly what was made, even on a step that fails. */
export interface AcceptanceCtx {
  readonly store: S3ObjectStore;
  readonly cfg: S3Config;
  readonly fetchImpl: typeof fetch;
  readonly key: (attempt: string) => string;
  readonly track: (key: string) => void;
  /** Optional sink for sanitized diagnostic evidence (label/status/code/outcome). The live harness wires a
   *  console reporter; offline reporter regressions capture it. See {@link DiagEvidence}. */
  readonly emit?: (evidence: DiagEvidence) => void;
}

/** PG1 — create-only / no-overwrite: create when absent; a second create-only is rejected as exists. */
export async function runPG1(ctx: AcceptanceCtx): Promise<void> {
  const { store, key, track } = ctx;
  const k1 = key('pg1');
  track(k1);
  const b1 = Buffer.from('{"pg1":true}', 'utf8');
  expect(await store.putIfAbsent(k1, b1, 'application/json')).toBe('created');
  expect(await store.putIfAbsent(k1, Buffer.from('{"pg1":"different"}', 'utf8'), 'application/json')).toBe('exists');
}

/** PG1-concurrent — two concurrent create-only to the SAME key ⇒ exactly one 'created', one 'exists'. */
export async function runPG1Concurrent(ctx: AcceptanceCtx): Promise<void> {
  const { store, key, track } = ctx;
  const kC = key('pg1-concurrent');
  track(kC);
  const b1 = Buffer.from('{"pg1":true}', 'utf8');
  // Wait for BOTH writes to SETTLE before propagating any failure. Promise.all rejects the moment one
  // rejects, letting the sibling keep writing/retrying past the step and race cleanup (a delete/list before
  // it finishes → a wrong empty-prefix result or incomplete counters). allSettled guarantees no in-flight
  // sibling outlives the step.
  const settled = await Promise.allSettled([
    store.putIfAbsent(kC, b1, 'application/json'),
    store.putIfAbsent(kC, b1, 'application/json'),
  ]);
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  const results = settled.map((s) => (s as PromiseFulfilledResult<'created' | 'exists'>).value);
  expect(results.filter((r) => r === 'created')).toHaveLength(1);
  expect(results.filter((r) => r === 'exists')).toHaveLength(1);
}

/** PG2 — GET/HEAD round-trip correctness; an absent key reads as absent. */
export async function runPG2(ctx: AcceptanceCtx): Promise<void> {
  const { store, key, track } = ctx;
  const k2 = key('pg2');
  track(k2);
  const b2 = Buffer.from('{"pg2":"round-trip"}', 'utf8');
  await store.putIfAbsent(k2, b2, 'application/json');
  expect((await store.head(k2))?.size).toBe(b2.length);
  expect((await store.get(k2)).equals(b2)).toBe(true);
  expect(await store.head(key('pg2-absent'))).toBeNull(); // never created ⇒ nothing to track
}

/**
 * PG3 — a present-but-WRONG checksum must be rejected by the provider with a CHECKSUM-SPECIFIC error.
 * A low-level probe deliberately sends a checksum that does not match the body (the normal putIfAbsent
 * always sends the correct one). Track the probe key BEFORE sending (so a wrongly-accepted object is still
 * cleaned up), and verify the object is ABSENT afterward. The BadDigest-only expectation is PRESERVED: an
 * HTTP 200 (provider accepted the mismatch) is a FAILURE, not a pass. Auth (401/403), 5xx, unsupported
 * (405), and any UNKNOWN/other code (incl. a generic 400) all FAIL CLOSED.
 */
export async function runPG3(ctx: AcceptanceCtx): Promise<void> {
  const { store, cfg, fetchImpl, key, track } = ctx;
  const k3 = key('pg3');
  track(k3);
  const b3 = Buffer.from('{"pg3":"bytes"}', 'utf8');
  const wrongChecksum = rawChecksumB64(Buffer.from('completely different bytes', 'utf8'));
  const signed = signS3Request(cfg, {
    method: 'PUT',
    key: k3,
    payloadHash: sha256Hex(b3),
    amzDate: amzDateNow(),
    extraHeaders: { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-checksum-sha256': wrongChecksum },
  });
  const wrongRes = await fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(b3) });
  const status = wrongRes.status;
  const errorBody = await wrongRes.text().catch(() => '');
  const code = parseS3ErrorCode(errorBody);
  expect([400, 422], `PG3: expected a checksum 4xx (got ${status})`).toContain(status);
  expect(isChecksumMismatchCode(code), `PG3: error code '${code}' is not an allow-listed checksum-mismatch code`).toBe(true);
  expect(await store.head(k3), 'PG3: a wrong-checksum object must never land').toBeNull();
}

/**
 * PG5 — "adapter overwrite guard + provider conditional-write enforcement". Proves exactly two mechanisms:
 *   (a) ADAPTER overwrite guard: the Hub's ordinary `put` refuses a verification-shaped key (no provider
 *       involved), so the Hub has no unconditional-overwrite code path.
 *   (b) PROVIDER conditional-write enforcement: a second conditional create-only PUT is rejected (→ exists).
 * It does NOT establish CREDENTIAL-LEVEL unconditional-overwrite protection — i.e. that the credential
 * itself would be DENIED a raw PUT WITHOUT If-None-Match. That requires a bucket policy / Object Lock and a
 * separate negative test; and Object Lock alone would not establish it either. So credential-level
 * unconditional-overwrite protection remains NOT VERIFIED regardless of this step's result.
 */
export async function runPG5(ctx: AcceptanceCtx): Promise<void> {
  const { store, key, track } = ctx;
  const k5 = key('pg5');
  track(k5);
  const b5 = Buffer.from('{"pg5":"immutable"}', 'utf8');
  await store.putIfAbsent(k5, b5, 'application/json');
  await expect(store.put(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).rejects.toThrow(/verification artifact object/); // (a)
  expect(await store.putIfAbsent(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).toBe('exists'); // (b)
  expect((await store.get(k5)).equals(b5)).toBe(true); // original bytes intact
}

// ─────────────────────────── PG3 checksum diagnostics (A / B / C) ───────────────────────────
// Three DIAGNOSTIC PUTs from the follow-up brief, probing how the provider treats an additional
// `x-amz-checksum-sha256` on a create-only PUT. Each is evaluated INDEPENDENTLY in the live harness and
// tracks its key BEFORE sending. A and B are OBSERVATIONAL for accept-vs-reject (PG3 owns the BadDigest-only
// pass/fail); they assert ONLY the invariant that a REJECTED write leaves nothing. C is a positive control
// identical to B (including the SDK algorithm header) but with a correct checksum + fresh key.

const DIAG_WRONG_SRC = Buffer.from('completely different bytes', 'utf8');
// A, B and C ALL use the ORIGINAL PG3 payload bytes, so A reproduces the exact PG3 request shape and the
// diagnostics differ only where intended — A↔B by the SDK-algorithm header, B↔C by the checksum value — plus
// the fresh key and the signing fields necessarily derived from those.
const DIAG_PAYLOAD = Buffer.from('{"pg3":"bytes"}', 'utf8');

/** Sanitized diagnostic evidence: the label, HTTP status, parsed provider error code, and absence/read-back
 *  outcome. It NEVER contains credentials, request bodies, or signed headers. */
export interface DiagEvidence {
  readonly label: string;
  readonly status: number;
  readonly code: string | null;
  readonly outcome: string; // e.g. 'rejected-absent' | 'rejected-present' | 'rejected' | 'accepted' | 'accepted-readback-ok' | 'accepted-readback-mismatch'
  readonly absentAfterReject: boolean | null;
  readonly readBackOk: boolean | null;
}

/** Send a signed checksum PUT for the A/B/C diagnostics (does NOT track — the step tracks first). All three
 *  send the SAME body (the PG3 payload). `sdkAlgo` adds `x-amz-sdk-checksum-algorithm: SHA256`; `correct`
 *  sends the true digest of the payload instead of a wrong one. Returns the raw response. */
async function putWithChecksum(ctx: AcceptanceCtx, key: string, opts: { sdkAlgo: boolean; correct: boolean }): Promise<Response> {
  const checksum = opts.correct ? rawChecksumB64(DIAG_PAYLOAD) : rawChecksumB64(DIAG_WRONG_SRC);
  const extraHeaders: Record<string, string> = { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-checksum-sha256': checksum };
  if (opts.sdkAlgo) extraHeaders['x-amz-sdk-checksum-algorithm'] = 'SHA256';
  const signed = signS3Request(ctx.cfg, { method: 'PUT', key, payloadHash: sha256Hex(DIAG_PAYLOAD), amzDate: amzDateNow(), extraHeaders });
  return ctx.fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(DIAG_PAYLOAD) });
}

export interface DiagOutcome {
  readonly status: number;
  readonly code: string | null;
  readonly absentAfterReject: boolean | null; // null when accepted (no rejection to check)
}

/** Shared body for A and B — the two OBSERVATIONAL diagnostics (accept-vs-reject is PG3's pass/fail; these
 *  assert only that a REJECTED write leaves nothing). The received status/code are captured BEFORE the HEAD
 *  and emitted in a `finally`, so they survive even if the HEAD or the absence assertion fails. */
async function runObservationalDiag(ctx: AcceptanceCtx, label: string, attempt: string, sdkAlgo: boolean): Promise<DiagOutcome> {
  const { store, key, track, emit } = ctx;
  const k = key(attempt);
  track(k);
  const res = await putWithChecksum(ctx, k, { sdkAlgo, correct: false });
  const status = res.status;
  const code = parseS3ErrorCode(await res.text().catch(() => ''));
  let absentAfterReject: boolean | null = null;
  let outcome = status < 300 ? 'accepted' : 'rejected';
  try {
    if (status >= 400) {
      absentAfterReject = (await store.head(k)) === null;
      outcome = absentAfterReject ? 'rejected-absent' : 'rejected-present';
      expect(absentAfterReject, `${label}: a rejected wrong-checksum write must leave nothing`).toBe(true);
    }
  } finally {
    emit?.({ label, status, code, outcome, absentAfterReject, readBackOk: null });
  }
  return { status, code, absentAfterReject };
}

/** Diagnostic A — the ORIGINAL wrong-checksum PUT (PG3 payload; NO SDK algorithm header). */
export async function runDiagAOriginalWrongChecksum(ctx: AcceptanceCtx): Promise<DiagOutcome> {
  return runObservationalDiag(ctx, 'DIAG-A', 'diag-a', false);
}

/** Diagnostic B — wrong checksum PLUS a signed `x-amz-sdk-checksum-algorithm: SHA256` (PG3 payload). Differs
 *  from A only by that header and the fresh key. */
export async function runDiagBAddedSdkAlgo(ctx: AcceptanceCtx): Promise<DiagOutcome> {
  return runObservationalDiag(ctx, 'DIAG-B', 'diag-b', true);
}

/** Diagnostic C — POSITIVE CONTROL identical to B (PG3 payload + SDK algorithm header) but a CORRECT checksum
 *  on a fresh key. Differs from B only by the checksum value (+ derived signing) and the key. Asserts the
 *  format is ACCEPTED and reads back byte-exact. This proves B's request FORMAT works when the checksum
 *  matches; it does NOT make an A/B rejection attributable to the checksum — auth/request-format/other errors
 *  remain distinct failure modes. Status/code are emitted in a `finally` so they survive a read-back failure. */
export async function runDiagCCorrectControl(ctx: AcceptanceCtx): Promise<void> {
  const { store, key, track, emit } = ctx;
  const k = key('diag-c');
  track(k);
  const res = await putWithChecksum(ctx, k, { sdkAlgo: true, correct: true });
  const status = res.status;
  const code = parseS3ErrorCode(await res.text().catch(() => ''));
  let readBackOk: boolean | null = null;
  let outcome = status < 300 ? 'accepted' : 'rejected';
  try {
    expect(status, `diag-C: B's request format with a CORRECT checksum must be accepted (got ${status})`).toBeLessThan(300);
    readBackOk = (await store.get(k)).equals(DIAG_PAYLOAD);
    outcome = readBackOk ? 'accepted-readback-ok' : 'accepted-readback-mismatch';
    expect(readBackOk, 'diag-C: byte-exact read-back of the positive control').toBe(true);
  } finally {
    emit?.({ label: 'DIAG-C', status, code, outcome, absentAfterReject: null, readBackOk });
  }
}

/** The three diagnostic PUTs, in order. Each is evaluated independently in the live harness. */
export const DIAGNOSTIC_STEPS: ReadonlyArray<{ name: string; run: (ctx: AcceptanceCtx) => Promise<unknown> }> = [
  { name: 'DIAG-A — original wrong-checksum PUT (no SDK algorithm header)', run: runDiagAOriginalWrongChecksum },
  { name: 'DIAG-B — wrong-checksum PUT + x-amz-sdk-checksum-algorithm', run: runDiagBAddedSdkAlgo },
  { name: 'DIAG-C — positive control: B format + correct checksum', run: runDiagCCorrectControl },
];

/** The ordered acceptance steps. The live harness runs EACH in its OWN test so one step's assertion failure
 *  does not prevent the others (notably PG5) from being evaluated. */
export const ACCEPTANCE_STEPS: ReadonlyArray<{ name: string; run: (ctx: AcceptanceCtx) => Promise<void> }> = [
  { name: 'PG1 — create-only / 412-on-exists', run: runPG1 },
  { name: 'PG1-concurrent — exactly one create', run: runPG1Concurrent },
  { name: 'PG2 — GET/HEAD round-trip', run: runPG2 },
  { name: 'PG3 — wrong-checksum rejected (BadDigest only)', run: runPG3 },
  { name: 'PG5 — adapter overwrite guard + provider conditional-write enforcement', run: runPG5 },
];

/** Sequential convenience wrapper (FAILS FAST at the first failing step). Used by the offline all-pass path;
 *  the live harness uses per-step tests instead so failures are isolated. */
export async function runAcceptanceScenarios(ctx: AcceptanceCtx): Promise<void> {
  for (const step of ACCEPTANCE_STEPS) await step.run(ctx);
}

/** Delete every tracked object, then LIST the run prefix and assert nothing remains. */
export async function cleanupAndVerify(args: { store: S3ObjectStore; prefix: string; created: readonly string[]; enterCleanupPhase?: () => void }): Promise<void> {
  args.enterCleanupPhase?.();
  for (const key of args.created) {
    try {
      await args.store.delete(key);
    } catch {
      /* best effort — a bucket lifecycle-expiry rule is the backstop */
    }
  }
  const remaining = typeof args.store.list === 'function' ? await args.store.list(args.prefix) : [];
  expect(remaining, `leftover objects under ${args.prefix}`).toEqual([]);
}

export interface RunTotals {
  readonly preCleanup: FetchStats;
  readonly final: FetchStats;
  readonly cleanupSucceeded: boolean;
  readonly cleanupError?: unknown;
}

/**
 * Run cleanup and ALWAYS report totals. Snapshots the PRE-CLEANUP counters, runs cleanup, and — in a
 * `finally`, so it happens EVEN IF cleanup throws — snapshots the FINAL counters and reports both plus
 * whether cleanup succeeded. Never throws for a cleanup failure; the caller inspects `cleanupSucceeded`
 * (the live harness asserts it true so a leftover object fails the suite). The default reporter logs counts
 * and a success boolean only (never the raw error, to avoid surfacing anything sensitive).
 */
export async function cleanupAndReport(args: {
  store: S3ObjectStore;
  prefix: string;
  created: readonly string[];
  budgeted: BudgetedFetch;
  report?: (totals: RunTotals) => void;
}): Promise<RunTotals> {
  const preCleanup = args.budgeted.stats();
  let cleanupSucceeded = false;
  let cleanupError: unknown;
  let final: FetchStats = preCleanup;
  try {
    await cleanupAndVerify({ store: args.store, prefix: args.prefix, created: args.created, enterCleanupPhase: args.budgeted.enterCleanupPhase });
    cleanupSucceeded = true;
  } catch (e) {
    cleanupError = e;
  } finally {
    final = args.budgeted.stats();
    const totals: RunTotals = { preCleanup, final, cleanupSucceeded, cleanupError };
    const report =
      args.report ??
      ((t: RunTotals): void => {
        console.log(`VER_S3_TOTALS ${JSON.stringify({ preCleanup: t.preCleanup, final: t.final, cleanupSucceeded: t.cleanupSucceeded })}`);
      });
    report(totals);
  }
  return { preCleanup, final, cleanupSucceeded, cleanupError };
}

/**
 * An in-memory S3 provider simulator (a fetch impl) for OFFLINE exercise of the acceptance logic. It
 * models the guarantees under test: create-only via `If-None-Match: *` (412 on an existing key),
 * checksum verification (400 on a mismatch), byte-exact GET/HEAD/absent, DELETE, and prefix LIST. It is
 * NOT a substitute for the live provider run — it only lets the harness's OWN key-selection/cleanup/budget
 * logic be tested without cloud access.
 */
export function makeInMemoryS3(
  cfg: S3Config,
  faults: { checksumMismatchStatus?: number; acceptWrongChecksum?: boolean; mismatchCode?: string } = {},
): { fetch: typeof fetch; objectCount: () => number } {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const bucketPath = `/${encodeURIComponent(cfg.bucket)}`;
  const decodeKey = (pathname: string): string =>
    pathname
      .slice(bucketPath.length + 1)
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');

  const fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const method = String(init.method ?? 'GET');
    const headers = (init.headers ?? {}) as Record<string, string>;

    // Bucket-level LIST (ListObjectsV2).
    if (u.pathname === bucketPath && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'content-length': String(Buffer.byteLength(xml)) } });
    }

    const key = decodeKey(u.pathname);
    if (method === 'PUT') {
      const body = Buffer.from((init.body as Uint8Array) ?? new Uint8Array());
      // Checksum verification (a mismatch is a hard reject — models provider PG3). Fault injection lets the
      // OFFLINE negative tests model a provider that mis-handles a mismatch (auth/5xx/unsupported, a
      // wrongly-accepted body, or a specific non-mismatch code) so the PG3 assertions are shown to catch it.
      const declared = headers['x-amz-checksum-sha256'];
      if (declared && declared !== createHash('sha256').update(body).digest('base64')) {
        if (faults.acceptWrongChecksum) {
          objects.set(key, { body, contentType: headers['content-type'] ?? 'application/octet-stream' });
          return new Response('', { status: 200, headers: { 'content-length': '0' } });
        }
        // Emit a SPECIFIC error code (e.g. the payload-signing code XAmzContentSHA256Mismatch) with a 4xx
        // status, so a PG3 negative test can prove that code fails closed despite a checksum-class status.
        if (faults.mismatchCode) {
          const xml = `<Error><Code>${faults.mismatchCode}</Code></Error>`;
          return new Response(xml, { status: faults.checksumMismatchStatus ?? 400, headers: { 'content-length': String(xml.length) } });
        }
        if (faults.checksumMismatchStatus) {
          return new Response('<Error><Code>NotAChecksumError</Code></Error>', { status: faults.checksumMismatchStatus });
        }
        return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400, headers: { 'content-length': String('<Error><Code>BadDigest</Code></Error>'.length) } });
      }
      // Create-only: If-None-Match:* fails if the key exists (models provider PG1).
      if (headers['if-none-match'] === '*' && objects.has(key)) {
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      }
      objects.set(key, { body, contentType: headers['content-type'] ?? 'application/octet-stream' });
      return new Response('', { status: 200, headers: { 'content-length': '0' } });
    }
    if (method === 'HEAD') {
      const o = objects.get(key);
      return o
        ? new Response(null, { status: 200, headers: { 'content-length': String(o.body.length), 'content-type': o.contentType } })
        : new Response(null, { status: 404 });
    }
    if (method === 'GET') {
      const o = objects.get(key);
      return o
        ? new Response(new Uint8Array(o.body), { status: 200, headers: { 'content-length': String(o.body.length), 'content-type': o.contentType } })
        : new Response(null, { status: 404 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, objectCount: () => objects.size };
}
