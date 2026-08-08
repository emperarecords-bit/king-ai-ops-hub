import type { FileWriteOperation } from './file-write-action';

export type ReconciliationConclusion = 'definitely_executed' | 'definitely_not_executed' | 'ambiguous';
export interface FileWriteReconciliationEvidence {
  readonly operation: FileWriteOperation;
  readonly expectedPreconditionSha256: string | null;
  readonly desiredPostconditionSha256: string;
  readonly inspectionComplete: boolean;
  readonly identityConsistent: boolean;
  readonly observedExists: boolean | null;
  readonly observedCurrentSha256: string | null;
  readonly tempArtifactObserved: boolean | null;
  readonly atomicCommitObserved: boolean | null;
  readonly intentAuditPresent: boolean;
  readonly resultAudit: 'succeeded' | 'not_executed' | 'failed' | null;
  readonly executorSelfReport: 'executed' | 'not_executed' | null;
}

export function reconcileFileWrite(e: FileWriteReconciliationEvidence): ReconciliationConclusion {
  if (!e.inspectionComplete || !e.identityConsistent || e.observedExists === null || e.tempArtifactObserved === null || e.atomicCommitObserved === null) return 'ambiguous';
  const finalMatches = e.observedExists && e.observedCurrentSha256 === e.desiredPostconditionSha256;
  if (finalMatches && e.intentAuditPresent && e.resultAudit !== 'not_executed') return 'definitely_executed';
  if (e.resultAudit === 'succeeded' && !finalMatches) return 'ambiguous';
  const unchanged = e.operation === 'create'
    ? !e.observedExists
    : e.observedExists && e.observedCurrentSha256 === e.expectedPreconditionSha256;
  if (unchanged && e.intentAuditPresent && !e.tempArtifactObserved && !e.atomicCommitObserved && e.resultAudit !== 'succeeded') return 'definitely_not_executed';
  return 'ambiguous';
}
