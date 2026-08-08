import { describe, expect, it } from 'vitest';
import { reconcileFileWrite, type FileWriteReconciliationEvidence } from '@/domain/execution/file-write-reconciliation';

const base: FileWriteReconciliationEvidence = {
  operation: 'replace', expectedPreconditionSha256: 'a'.repeat(64), desiredPostconditionSha256: 'b'.repeat(64),
  inspectionComplete: true, identityConsistent: true, observedExists: true, observedCurrentSha256: 'b'.repeat(64),
  tempArtifactObserved: false, atomicCommitObserved: true, intentAuditPresent: true, resultAudit: null, executorSelfReport: null,
};

describe('mock file-write reconciliation', () => {
  it('proves execution from consistent final bytes even after a lost result', () => {
    expect(reconcileFileWrite(base)).toBe('definitely_executed');
  });
  it('proves not-executed only from complete unchanged independent evidence', () => {
    expect(reconcileFileWrite({ ...base, observedCurrentSha256: 'a'.repeat(64), atomicCommitObserved: false })).toBe('definitely_not_executed');
    expect(reconcileFileWrite({ ...base, operation: 'create', expectedPreconditionSha256: null, observedExists: false, observedCurrentSha256: null, atomicCommitObserved: false })).toBe('definitely_not_executed');
  });
  it.each([
    { inspectionComplete: false }, { identityConsistent: false }, { observedExists: null },
    { observedCurrentSha256: 'c'.repeat(64) }, { resultAudit: 'succeeded' as const, observedCurrentSha256: 'a'.repeat(64) },
    { executorSelfReport: 'not_executed' as const, observedCurrentSha256: 'c'.repeat(64) },
    { tempArtifactObserved: null }, { atomicCommitObserved: null },
  ])('keeps unavailable, conflicting, timeout-like, or self-reported evidence ambiguous: %o', (change) => {
    expect(reconcileFileWrite({ ...base, ...change })).toBe('ambiguous');
  });
});
