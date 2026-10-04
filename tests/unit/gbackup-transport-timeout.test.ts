import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES,
  DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS,
  type ReceiptFetchResult,
  type ReceiptFetcher,
  fetchAndVerifyReceiptV2,
} from '../../scripts/backup/receipt-transport';
import { type ReceiptV2Expectation } from '../../scripts/backup/receipt-v2-verify';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';
import { buildControls } from '../../scripts/ci/publish-receipt';

/**
 * Issue #123 — G-Backup receipt transport timeout hardening. Deterministic, OFFLINE tests (fake fetcher + fake
 * timers; no real network/S3/Fly, no multi-second wall-clock sleeps). Proves: the shared default is 5000 ms, an
 * explicit override still wins, a fetch delayed below budget reaches verification, a fetch beyond budget fails
 * CLOSED as a transport timeout without reaching verification, existing transport protections are intact, and
 * exactly ONE request is issued (no retry).
 */

const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const LOC = { baseUrl: 'https://receipts.example.com', environment: 'staging' as const, targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE };
const HOSTS = new Set(['receipts.example.com']);
const controls = (timeoutMs: number) => ({ maxBytes: DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES, timeoutMs, hostAllowlist: HOSTS });

const kp = generateKeyPairSync('ed25519');
const PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function expectation(): ReceiptV2Expectation {
  const l = loadReceiptKeyBundle([{ keyId: 't', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active' }]);
  if (!l.ok) throw new Error(l.code);
  return {
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: '7300338420798239475',
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000,
    sourceCommit: 'a'.repeat(40), expectedRegistryNamespace: 'registry.fly.io/king-ai-ops-hub-staging', deploymentNonce: NONCE,
    portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64), pendingMigrations: [],
    migrationStartedAt: new Date('2026-08-01T12:00:00.000Z'), supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']), keyStore: l.store,
  };
}

/** Fetcher whose single response is delayed by `delayMs` of (fake) time. Counts calls to prove no retry. */
function delayedFetcher(delayMs: number, result: ReceiptFetchResult, counter: { n: number }): ReceiptFetcher {
  return {
    fetchOnce() {
      counter.n++;
      return new Promise<ReceiptFetchResult>((resolve) => { setTimeout(() => resolve(result), delayMs); });
    },
  };
}
/** Fetcher that resolves immediately with the given response (for transport-protection assertions). */
function immediateFetcher(result: ReceiptFetchResult, counter = { n: 0 }): { f: ReceiptFetcher; counter: { n: number } } {
  return { counter, f: { fetchOnce() { counter.n++; return Promise.resolve(result); } } };
}
const OK200 = (bytes: Buffer): ReceiptFetchResult => ({ status: 200, bytes, contentEncoding: null, redirected: false });

afterEach(() => { vi.useRealTimers(); });

describe('#123 transport timeout — shared default + override (behavioral)', () => {
  const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
  it('A. the shared default receipt transport timeout is 5000 ms', () => {
    expect(DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS).toBe(5000);
    // Behavioral: the publisher control builder uses the shared default when no override is set.
    expect(buildControls(env({ GBACKUP_RECEIPT_HOSTS: 'h.example.com' })).timeoutMs).toBe(5000);
    expect(buildControls(env({ GBACKUP_RECEIPT_HOSTS: 'h.example.com' })).maxBytes).toBe(DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES);
  });
  it('B. an explicit GBACKUP_TRANSPORT_TIMEOUT_MS still overrides the default', () => {
    expect(buildControls(env({ GBACKUP_RECEIPT_HOSTS: 'h.example.com', GBACKUP_TRANSPORT_TIMEOUT_MS: '1234' })).timeoutMs).toBe(1234);
  });
  it('the release gate (migrate.ts) sources its default from the shared constant, not a literal', () => {
    // migrate.ts runs main() at import, so assert its source wiring statically (anti-drift guard for the gate path).
    const src = readFileSync(join(process.cwd(), 'scripts', 'migrate.ts'), 'utf8');
    expect(src).toContain('DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS');
    expect(src).toMatch(/transportTimeoutMs:\s*intEnv\(env\.GBACKUP_TRANSPORT_TIMEOUT_MS,\s*DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS\)/);
    expect(src).not.toMatch(/transportTimeoutMs:\s*intEnv\([^)]*,\s*2000\)/);
  });
});

describe('#123 transport timeout — delayed fetch behavior (fake timers, deterministic)', () => {
  it('C. a first fetch delayed BELOW the timeout reaches verification (no timeout fired)', async () => {
    vi.useFakeTimers();
    const counter = { n: 0 };
    // Bad JSON so verification returns a VERIFY-stage result — proving the transport layer completed within budget.
    const p = fetchAndVerifyReceiptV2(delayedFetcher(1000, OK200(Buffer.from('{bad json')), counter), LOC, controls(5000), expectation());
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('verify');
      expect(r.code).toBe('json_invalid');
    }
    expect(counter.n).toBe(1);
  });

  it('D. a first fetch delayed BEYOND the timeout fails CLOSED as a transport timeout (verify never reached)', async () => {
    vi.useFakeTimers();
    const counter = { n: 0 };
    // Fetch would eventually return VALID-looking bytes, but far past the 5000 ms budget.
    const p = fetchAndVerifyReceiptV2(delayedFetcher(60_000, OK200(Buffer.from('{"receipt":true}')), counter), LOC, controls(5000), expectation());
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('transport'); // NOT 'verify' → verification/migration path never reached
      expect(r.code).toBe('timeout');
    }
    expect(counter.n).toBe(1); // F. exactly one request even on timeout — no retry
  });

  it('F. no unintended retry — success path also issues exactly one request', async () => {
    vi.useFakeTimers();
    const counter = { n: 0 };
    const p = fetchAndVerifyReceiptV2(delayedFetcher(10, OK200(Buffer.from('{bad')), counter), LOC, controls(5000), expectation());
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(counter.n).toBe(1);
  });
});

describe('#123 transport timeout — existing transport protections remain fail-closed', () => {
  it('E. non-200 / redirect / oversize / empty all fail at the transport stage', async () => {
    const nn = async (r: ReceiptFetchResult) => fetchAndVerifyReceiptV2(immediateFetcher(r).f, LOC, controls(5000), expectation());
    expect(await nn({ status: 404, bytes: Buffer.from('x'), contentEncoding: null, redirected: false })).toMatchObject({ ok: false, stage: 'transport', code: 'bad_status' });
    expect(await nn({ status: 302, bytes: Buffer.alloc(0), contentEncoding: null, redirected: true })).toMatchObject({ ok: false, stage: 'transport', code: 'redirect' });
    expect(await nn(OK200(Buffer.alloc(DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES + 1, 0x20)))).toMatchObject({ ok: false, stage: 'transport', code: 'oversize' });
    expect(await nn(OK200(Buffer.alloc(0)))).toMatchObject({ ok: false, stage: 'transport', code: 'empty' });
  });
  it('E. a valid transport response is still handed to the verifier unchanged (signature/receipt validation intact)', async () => {
    // Transport passes (200, small, identity, no redirect) → verifier runs and rejects malformed JSON at step 2.
    const r = await fetchAndVerifyReceiptV2(immediateFetcher(OK200(Buffer.from('{not valid'))).f, LOC, controls(5000), expectation());
    expect(r).toMatchObject({ ok: false, stage: 'verify', code: 'json_invalid' });
  });
});
