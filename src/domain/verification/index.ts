/**
 * Verification & evidence (VER-001) — the Hub's honesty layer.
 *
 * Pure, framework-free logic that distinguishes what an agent CLAIMED from what
 * was actually executed and verified. Not yet wired into the live task path; see
 * the acceptance demo (scripts/verification-acceptance-demo.ts) for the end-to-end
 * proof against a synthetic repository.
 */
export * from './types';
export * from './access';
export * from './adjudicate';
export * from './sanitize';
export * from './export';
// VER-002 — external-runner evidence ingestion (Option A).
export * from './ingest-types';
export * from './create-request';
export * from './signing';
export * from './binding';
export * from './checks';
export * from './tenant-key';
export * from './artifacts-availability';
export * from './ports';
export * from './ingest';
export * from './approval-details';
export * from './view';
export * from './memory-adapters';
