import { describe, expect, it } from 'vitest';
import { validateFileWriteRelativePath } from '@/domain/execution/file-write-path-policy';
import { evaluateFileWriteInspection } from '@/domain/execution/file-write-link-policy';
import { canonicalizeFileWriteAction } from '@/domain/execution/file-write-action';
import { confirmationBindingSha256, validateConfirmationUse, type FileWriteConfirmationFields } from '@/domain/execution/file-write-confirmation';
import { classifyIdempotency, interruptionOutcome, mayClaimAttempt } from '@/domain/execution/executor-lifecycle-policy';
import { reconcileFileWrite, type FileWriteReconciliationEvidence } from '@/domain/execution/file-write-reconciliation';
import { executorEnablementId, isExecutorEnabled, resolveDispatchPolicyFromEnv } from '@/domain/execution/dispatch';
import { NOOP_EXECUTOR_CAPABILITY } from '@/domain/execution/noop-executor';

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
  it('denies duplicate conflicts, concurrent claims, and — on the real dispatch gate — an unset or killed allowlist, a foreign executor identity, and live mode', () => {
    expect(classifyIdempotency('binding-a', 'binding-b')).toBe('conflict');
    expect(mayClaimAttempt('confirmed', 1, 2, true)).toBe(false);

    // file_write passes the SAME single gate the git_pr / supabase_deploy / vercel_mutation connectors
    // pass: exact membership of the resolved enablement id in EXECUTORS_ENABLED, fail-closed when unset,
    // emptied by EXECUTORS_KILL_SWITCH. It is now addressed by its own action type rather than by the
    // shared no-op's id, so enabling it enables file_write ALONE. This calls the gate's OWN predicate and
    // the real enablement resolver, so a change to either fails here; it replaces the unwired four-layer
    // enablement policy that used to be asserted at this spot and never gated anything in production.
    const enabled = (env: Record<string, string | undefined>): boolean =>
      isExecutorEnabled(
        resolveDispatchPolicyFromEnv(env),
        executorEnablementId('file_write', NOOP_EXECUTOR_CAPABILITY.executorId),
      );

    expect(enabled({ EXECUTORS_ENABLED: 'file_write' })).toBe(true); // positive control: it CAN be enabled
    expect(enabled({})).toBe(false); // absence of configuration never enables
    expect(enabled({ EXECUTORS_ENABLED: 'file_write', EXECUTORS_KILL_SWITCH: '1' })).toBe(false);
    expect(enabled({ EXECUTORS_ENABLED: 'file_write', EXECUTORS_KILL_SWITCH: 'true' })).toBe(false);
    // Exact string match: not the shared no-op's id — which used to enable it for EVERY action type
    // routed to the same instance — not a prefix/suffix, not a different case, and not a direct-write
    // identity the model or client might claim.
    for (const value of ['noop_dry_run', 'client_direct', 'model_direct', 'noop', 'file_write_extra', 'FILE_WRITE']) {
      expect(enabled({ EXECUTORS_ENABLED: value })).toBe(false);
    }
    // A sibling connector's name never enables file_write, and the resolver leaves a real connector's
    // own id alone — a resolver that returned the action type for everything would pass the rest of
    // this block while quietly renaming every gate in the system.
    expect(enabled({ EXECUTORS_ENABLED: 'git_pr,supabase_deploy,vercel_mutation' })).toBe(false);
    expect(executorEnablementId('git_pr', 'git_pr')).toBe('git_pr');
    expect(executorEnablementId('supabase_deploy', 'supabase_deploy')).toBe('supabase_deploy');
    expect(executorEnablementId('external_http', 'accuratebids_quote')).toBe('accuratebids_quote');
    // Even once enabled, a LIVE file_write cannot run: the resolved executor is dry-run only.
    expect([...NOOP_EXECUTOR_CAPABILITY.supportedModes] as string[]).not.toContain('live');
    expect(NOOP_EXECUTOR_CAPABILITY.externalSideEffects).toBe(false);
  });
  it('keeps crash, timeout, unavailable evidence, fake not-executed, and conflicts ambiguous', () => {
    expect(interruptionOutcome('worker_crash', true)).toBe('ambiguous');
    expect(interruptionOutcome('timeout', true)).toBe('ambiguous');
    const evidence: FileWriteReconciliationEvidence = { operation: 'replace', expectedPreconditionSha256: 'a'.repeat(64), desiredPostconditionSha256: 'b'.repeat(64), inspectionComplete: false, identityConsistent: true, observedExists: null, observedCurrentSha256: null, tempArtifactObserved: null, atomicCommitObserved: null, intentAuditPresent: true, resultAudit: null, executorSelfReport: 'not_executed' };
    expect(reconcileFileWrite(evidence)).toBe('ambiguous');
    expect(reconcileFileWrite({ ...evidence, inspectionComplete: true, observedExists: true, observedCurrentSha256: 'c'.repeat(64), tempArtifactObserved: false, atomicCommitObserved: false, resultAudit: 'succeeded' })).toBe('ambiguous');
  });
});
