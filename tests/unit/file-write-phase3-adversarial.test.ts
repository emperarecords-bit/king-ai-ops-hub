import { describe, expect, it } from 'vitest';
import { validateFileWriteRelativePath } from '@/domain/execution/file-write-path-policy';
import { evaluateFileWriteInspection } from '@/domain/execution/file-write-link-policy';
import { canonicalizeFileWriteAction } from '@/domain/execution/file-write-action';
import { confirmationBindingSha256, validateConfirmationUse, type FileWriteConfirmationFields } from '@/domain/execution/file-write-confirmation';
import { classifyIdempotency, interruptionOutcome, mayClaimAttempt } from '@/domain/execution/executor-lifecycle-policy';
import { reconcileFileWrite, type FileWriteReconciliationEvidence } from '@/domain/execution/file-write-reconciliation';
import { evaluateExecutorEnablement, type ExecutorEnablementInput } from '@/domain/execution/executor-enablement-policy';

describe('consolidated Phase 3 file-write adversarial suite (no I/O)', () => {
  it.each(['../x.md', '/etc/passwd.txt', 'C:/Windows/x.txt', '\\\\host\\share\\x.txt', '.git/config.txt', 'foo/.git/x.md', 'node_modules/x/readme.md', '.env.txt', 'plans/a\u202eb.md'])('denies path attack %s', (path) => {
    expect(validateFileWriteRelativePath(path).allowed).toBe(false);
  });
  it.each(['symlink', 'junction', 'reparse_point', 'special', 'unknown'] as const)('denies link/component kind %s', (kind) => {
    expect(evaluateFileWriteInspection({ components: [{ normalizedPath: 'plans', kind: 'directory', identity: 'p', parentIdentity: 'w', hardLinkCount: 1 }], target: { normalizedPath: 'plans/a.md', kind, identity: 't', parentIdentity: 'p', hardLinkCount: 1 } }).allowed).toBe(false);
  });
  it('denies oversized, binary-intent, malformed-hash, and unsupported actions', () => {
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: 'a'.repeat(256 * 1024 + 1) }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.txt', payload: '\0x' }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'replace', target: 'plans/a.txt', payload: 'x', expectedCurrentSha256: 'bad' }).allowed).toBe(false);
    expect(canonicalizeFileWriteAction({ operation: 'delete', target: 'plans/a.txt', payload: '' }).allowed).toBe(false);
  });
  it('denies stale, reused, cross-workspace, actor, payload, and path confirmation changes', () => {
    const action = canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.md', payload: 'x' });
    if (!action.allowed) throw new Error('fixture invalid');
    const value: FileWriteConfirmationFields = { confirmationId: 'c', orgId: 'o', projectId: 'p', actorId: 'a', executorId: 'file_write', riskClass: 'reversible_internal_write', mode: 'live', confirmedAt: '2026-08-08T12:00:00.000Z', expiresAt: '2026-08-08T12:10:00.000Z', action: action.action };
    const digest = confirmationBindingSha256(value);
    expect(validateConfirmationUse(value, digest, new Date(value.expiresAt), new Set()).allowed).toBe(false);
    expect(validateConfirmationUse(value, digest, new Date('2026-08-08T12:01:00Z'), new Set(['c'])).allowed).toBe(false);
    for (const changed of [{ ...value, projectId: 'other' }, { ...value, actorId: 'other' }, { ...value, action: { ...value.action, payloadSha256: 'b'.repeat(64) } }, { ...value, action: { ...value.action, normalizedTarget: 'plans/b.md' } }]) {
      expect(validateConfirmationUse(changed, digest, new Date('2026-08-08T12:01:00Z'), new Set()).allowed).toBe(false);
    }
  });
  it('denies duplicate conflicts, concurrent claims, disabled/client/model direct live dispatch, and kill switch', () => {
    expect(classifyIdempotency('binding-a', 'binding-b')).toBe('conflict');
    expect(mayClaimAttempt('confirmed', 1, 2, true)).toBe(false);
    const base: ExecutorEnablementInput = { mode: 'live', environmentAllowsExecutors: true, executorFamilyEnabled: true, workspaceEnabled: true, fileWriteEnabled: true, emergencyKillSwitch: false, requestedOrgId: 'o', requestedProjectId: 'p', configuredOrgId: 'o', configuredProjectId: 'p', requestedExecutorId: 'file_write', configuredExecutorId: 'file_write' };
    expect(evaluateExecutorEnablement({ ...base, fileWriteEnabled: false }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...base, requestedExecutorId: 'client_direct' }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...base, requestedExecutorId: 'model_direct' }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...base, emergencyKillSwitch: true }).allowed).toBe(false);
  });
  it('keeps crash, timeout, unavailable evidence, fake not-executed, and conflicts ambiguous', () => {
    expect(interruptionOutcome('worker_crash', true)).toBe('ambiguous');
    expect(interruptionOutcome('timeout', true)).toBe('ambiguous');
    const evidence: FileWriteReconciliationEvidence = { operation: 'replace', expectedPreconditionSha256: 'a'.repeat(64), desiredPostconditionSha256: 'b'.repeat(64), inspectionComplete: false, identityConsistent: true, observedExists: null, observedCurrentSha256: null, tempArtifactObserved: null, atomicCommitObserved: null, intentAuditPresent: true, resultAudit: null, executorSelfReport: 'not_executed' };
    expect(reconcileFileWrite(evidence)).toBe('ambiguous');
    expect(reconcileFileWrite({ ...evidence, inspectionComplete: true, observedExists: true, observedCurrentSha256: 'c'.repeat(64), tempArtifactObserved: false, atomicCommitObserved: false, resultAudit: 'succeeded' })).toBe('ambiguous');
  });
});
