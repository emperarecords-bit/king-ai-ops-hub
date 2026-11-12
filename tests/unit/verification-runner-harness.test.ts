/**
 * VER-002 PR-8 — stage 1, the properties that make a signature mean something.
 *
 * The point of these tests is not that the harness runs commands; it is that it REFUSES to in the
 * conditions design §2.2–2.3 say are unsafe, and that what it records cannot be influenced by the
 * code it ran.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  probeIsolation,
  requireIsolation,
  IsolationError,
  prepareSink,
  readRecords,
  writeRecord,
  isInside,
  SinkError,
  runCheck,
  minimalEnv,
  statusFor,
  assertValidRecord,
  type HarnessRecord,
  type IsolationReport,
} from '../../services/verification-runner/src/harness';

const POSIX = platform() !== 'win32';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A literal enforced report for the record-shape tests. Not derived from `probeIsolation`, because
 * that correctly reports `enforced: false` on win32 — a derived fixture would mean these tests
 * asserted different things on a dev box and on CI. The probe's own behaviour is asserted directly
 * in the isolation block above.
 */
const ENFORCED: IsolationReport = {
  enforced: true,
  controls: { separateExecutionUid: true, sandboxed: true, egressDenied: true, sinkUnreachableByExecution: true },
  gaps: [],
  platform: 'linux',
};

describe('PR-8 harness — isolation fails CLOSED', () => {
  it('reports not-enforced with named gaps when nothing is declared', () => {
    const r = probeIsolation({});
    expect(r.enforced).toBe(false);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.controls.sandboxed).toBe(false);
    expect(r.controls.egressDenied).toBe(false);
  });

  it('refuses to run unisolated unless explicitly allowed, and the error names every gap', () => {
    const r = probeIsolation({});
    expect(() => requireIsolation(r, false)).toThrow(IsolationError);
    let message = '';
    try {
      requireIsolation(r, false);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const gap of r.gaps) expect(message).toContain(gap);
    expect(() => requireIsolation(r, true)).not.toThrow();
  });

  it('never claims a uid barrier when the executing uid equals the collector uid', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid === null) return; // win32: covered by the platform test below
    const r = probeIsolation({ executionUid: uid, sandboxed: true, egressDenied: true });
    expect(r.controls.separateExecutionUid).toBe(false);
    expect(r.enforced).toBe(false);
  });

  it('can never report enforced on win32, because a child cannot change uid there', () => {
    if (POSIX) return;
    const r = probeIsolation({ executionUid: 12_345, sandboxed: true, egressDenied: true });
    expect(r.enforced).toBe(false);
    expect(r.gaps.join(' ')).toContain('win32');
  });

  it('treats the sink as reachable whenever there is no uid barrier (0700 protects nothing from its owner)', () => {
    const r = probeIsolation({ sandboxed: true, egressDenied: true });
    expect(r.controls.sinkUnreachableByExecution).toBe(false);
  });
});

describe('PR-8 harness — the sink cannot be forged', () => {
  it('refuses a sink inside the checkout, where the code under test could write it', () => {
    const checkout = tmp('pr8-checkout-');
    expect(() => prepareSink(join(checkout, 'results'), checkout)).toThrow(SinkError);
    expect(() => prepareSink(checkout, checkout)).toThrow(SinkError);
  });

  it('accepts a sibling directory whose name merely shares a prefix with the checkout', () => {
    // A startsWith implementation would wrongly reject this; isInside must not.
    const root = tmp('pr8-root-');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const sink = join(root, 'checkout-sink');
    expect(isInside(checkout, sink)).toBe(false);
    expect(() => prepareSink(sink, checkout)).not.toThrow();
  });

  it('creates the sink 0700 and owned by the collector on POSIX', () => {
    if (!POSIX) return;
    const root = tmp('pr8-mode-');
    const sink = prepareSink(join(root, 'sink'), join(root, 'checkout'));
    expect(statSync(sink).mode & 0o777).toBe(0o700);
  });

  it('round-trips records and refuses a check name that would escape the sink', () => {
    const root = tmp('pr8-rt-');
    const sink = prepareSink(join(root, 'sink'), join(root, 'checkout'));
    const rec: HarnessRecord = {
      schema: 'king-verification-harness/v1',
      name: 'unit',
      command: 'npm run test:unit',
      status: 'passed',
      exitCode: 0,
      timedOut: false,
      startedAt: '2026-11-12T00:00:00.000Z',
      finishedAt: '2026-11-12T00:00:01.000Z',
      durationMs: 1000,
      outputDigest: null,
      outputBytes: 0,
      isolation: ENFORCED,
      runId: 'run-1',
    };
    writeRecord(sink, rec);
    expect(readRecords(sink)).toEqual([rec]);
    expect(() => writeRecord(sink, { ...rec, name: '../escape' })).toThrow(SinkError);
  });

  it('ignores a forged results file sitting in the checkout (§2.2)', () => {
    const root = tmp('pr8-forge-');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'results.json'), JSON.stringify({ unit: 'passed' }), 'utf8');
    const sink = prepareSink(join(root, 'sink'), checkout);
    // The signer reads the SINK; the checkout file is simply never consulted.
    expect(readRecords(sink)).toEqual([]);
    expect(existsSync(join(checkout, 'results.json'))).toBe(true);
  });
});

describe('PR-8 harness — authoritative capture', () => {
  it('records the real exit code from the OS, not anything the command claims', async () => {
    const root = tmp('pr8-exit-');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const rec = await runCheck({
      name: 'failing',
      // Prints passing-looking output AND exits non-zero. The record must say failed.
      command: 'node -e "process.stdout.write(\'PASSED\'); process.exit(3)"',
      checkoutDir: checkout,
      runId: 'run-x',
      isolation: ENFORCED,
      timeoutMs: 30_000,
    });
    expect(rec.status).toBe('failed');
    expect(rec.exitCode).toBe(3);
    expect(rec.timedOut).toBe(false);
    expect(rec.runId).toBe('run-x');
  });

  it('records a passing command as passed with a real duration and output digest', async () => {
    const root = tmp('pr8-pass-');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const rec = await runCheck({
      name: 'ok',
      command: 'node -e "process.stdout.write(String(1))"',
      checkoutDir: checkout,
      runId: 'run-y',
      isolation: ENFORCED,
      timeoutMs: 30_000,
    });
    expect(rec.status).toBe('passed');
    expect(rec.exitCode).toBe(0);
    expect(rec.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(rec.finishedAt)).toBeGreaterThanOrEqual(Date.parse(rec.startedAt));
  });

  it('classifies a timeout as errored, never as a test failure', async () => {
    const root = tmp('pr8-timeout-');
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    const rec = await runCheck({
      name: 'slow',
      command: 'node -e "setTimeout(function () {}, 60000)"',
      checkoutDir: checkout,
      runId: 'run-z',
      isolation: ENFORCED,
      timeoutMs: 400,
    });
    expect(rec.timedOut).toBe(true);
    expect(rec.status).toBe('errored');
  });

  it('does not leak the collector environment into the child by default', () => {
    const env = minimalEnv();
    expect(env['HUB_RUNNER_SIGNING_SECRET']).toBeUndefined();
    expect(env['HUB_RUNNER_KEY_SECRET']).toBeUndefined();
    expect(env.CI).toBe('1');
    expect(typeof env.PATH).toBe('string');
  });

  it('maps statuses so unknown and timed-out stay distinguishable from a failure', () => {
    expect(statusFor(0, false)).toBe('passed');
    expect(statusFor(1, false)).toBe('failed');
    expect(statusFor(null, false)).toBe('errored');
    expect(statusFor(0, true)).toBe('errored');
  });

  it('rejects a record with an unknown schema or a missing isolation report', () => {
    expect(() => assertValidRecord({ schema: 'other/v9' }, 'ctx')).toThrow(/unknown record schema/);
    expect(() =>
      assertValidRecord(
        {
          schema: 'king-verification-harness/v1',
          name: 'a',
          command: 'b',
          status: 'passed',
          startedAt: 'x',
          finishedAt: 'y',
          runId: 'r',
          durationMs: 1,
          exitCode: 0,
          timedOut: false,
        },
        'ctx',
      ),
    ).toThrow(/missing isolation report/);
  });
});
