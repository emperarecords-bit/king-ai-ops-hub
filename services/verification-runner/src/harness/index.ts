/**
 * Stage 1 — the out-of-tree execution harness (design §2.2–2.3).
 *
 * Order matters here and is not incidental:
 *   1. resolve the catalog and assert it is the one the CONTRACT pinned — so we never run commands
 *      from an unreviewed catalog;
 *   2. probe isolation and refuse unless enforced — so untrusted commands never run unprotected;
 *   3. prepare the sink and assert it is outside the checkout — so results cannot be forged;
 *   4. only then execute.
 *
 * Each step is a refusal point. Nothing is executed until all three guarantees hold.
 */
import { randomUUID } from 'node:crypto';
import { assertCatalogPinMatches, loadCatalogVersion, resolveRequiredCommands, type ResolvedCatalog } from '../catalog';
import type { VerificationContract } from '../contract';
import { probeIsolation, requireIsolation, type IsolationOptions, type IsolationReport } from './isolation';
import { prepareSink, writeRecord } from './sink';
import { runCheck } from './run-check';
import type { HarnessRecord } from './records';

export interface HarnessOptions {
  readonly contract: VerificationContract;
  readonly checkoutDir: string;
  readonly sinkDir: string;
  readonly catalogDir: string;
  readonly timeoutMs: number;
  readonly isolation: IsolationOptions;
  /** Explicit, recorded opt-out for a trusted local dry run. Never a default. */
  readonly allowUnisolated?: boolean;
  /** Supplied so a caller can correlate a harness run with its attestation. */
  readonly runId?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface HarnessResult {
  readonly runId: string;
  readonly sinkDir: string;
  readonly catalog: ResolvedCatalog;
  readonly isolation: IsolationReport;
  readonly records: readonly HarnessRecord[];
}

export async function runHarness(opts: HarnessOptions): Promise<HarnessResult> {
  // 1. Catalog identity, before anything is executed.
  const catalog = loadCatalogVersion(opts.catalogDir, opts.contract.catalogVersion);
  assertCatalogPinMatches(opts.contract, catalog);
  const commands = resolveRequiredCommands(opts.contract.requiredChecks, catalog);

  // 2. Isolation, before anything is executed.
  const isolation = probeIsolation(opts.isolation);
  requireIsolation(isolation, opts.allowUnisolated === true);

  // 3. Sink, before anything is executed.
  const sinkDir = prepareSink(opts.sinkDir, opts.checkoutDir);

  // 4. Execute. Sequentially, because concurrent checks would contend for the same checkout and
  //    make the recorded wall-clock durations meaningless as evidence.
  const runId = opts.runId ?? randomUUID();
  const records: HarnessRecord[] = [];
  for (const { name, command } of commands) {
    const record = await runCheck({
      name,
      command,
      checkoutDir: opts.checkoutDir,
      runId,
      isolation,
      timeoutMs: opts.timeoutMs,
      ...(opts.isolation.executionUid !== undefined ? { executionUid: opts.isolation.executionUid } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    writeRecord(sinkDir, record);
    records.push(record);
  }

  return { runId, sinkDir, catalog, isolation, records };
}

export { probeIsolation, requireIsolation, IsolationError } from './isolation';
export { prepareSink, readRecords, writeRecord, isInside, SinkError } from './sink';
export { runCheck, minimalEnv } from './run-check';
export { assertValidRecord, statusFor } from './records';
export type { HarnessRecord, CheckStatus } from './records';
export type { IsolationControls, IsolationOptions, IsolationReport } from './isolation';
