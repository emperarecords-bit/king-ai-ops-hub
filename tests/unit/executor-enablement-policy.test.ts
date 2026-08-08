import { describe, expect, it } from 'vitest';
import { evaluateExecutorEnablement, type ExecutorEnablementInput } from '@/domain/execution/executor-enablement-policy';

const enabled: ExecutorEnablementInput = {
  mode: 'live', environmentAllowsExecutors: true, executorFamilyEnabled: true, workspaceEnabled: true, fileWriteEnabled: true,
  emergencyKillSwitch: false, requestedOrgId: 'org-1', requestedProjectId: 'project-1', configuredOrgId: 'org-1',
  configuredProjectId: 'project-1', requestedExecutorId: 'file_write', configuredExecutorId: 'file_write',
};

describe('four-layer executor enablement and kill switch', () => {
  it('allows live only when all layers match and kill switch is explicitly off', () => {
    expect(evaluateExecutorEnablement(enabled)).toMatchObject({ allowed: true, decision: 'allow_live' });
  });
  it.each(['environmentAllowsExecutors', 'executorFamilyEnabled', 'workspaceEnabled', 'fileWriteEnabled'] as const)('denies when %s is false, missing, or malformed', (key) => {
    expect(evaluateExecutorEnablement({ ...enabled, [key]: false }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...enabled, [key]: undefined }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...enabled, [key]: 'true' }).allowed).toBe(false);
  });
  it('kill switch overrides all enabled layers and defaults to deny when unknown', () => {
    for (const value of [true, undefined, 'false', null]) expect(evaluateExecutorEnablement({ ...enabled, emergencyKillSwitch: value }).allowed).toBe(false);
  });
  it('denies workspace and executor mismatches', () => {
    expect(evaluateExecutorEnablement({ ...enabled, configuredProjectId: 'project-2' }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...enabled, configuredOrgId: 'org-2' }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...enabled, requestedExecutorId: 'model_direct' }).allowed).toBe(false);
    expect(evaluateExecutorEnablement({ ...enabled, configuredExecutorId: 'other' }).allowed).toBe(false);
  });
  it('allows side-effect-free dry-run without treating live layers as enabled', () => {
    const decision = evaluateExecutorEnablement({ ...enabled, mode: 'dry_run', environmentAllowsExecutors: false, emergencyKillSwitch: true });
    expect(decision).toMatchObject({ allowed: true, decision: 'allow_dry_run' });
    expect(decision.auditableInputs).toMatchObject({ emergencyKillSwitch: true, environmentAllowsExecutors: false });
  });
});
