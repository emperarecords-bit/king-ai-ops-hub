import type { ExecutionMode } from './executor-contract';

export interface ExecutorEnablementInput {
  readonly mode: ExecutionMode;
  readonly environmentAllowsExecutors: unknown;
  readonly executorFamilyEnabled: unknown;
  readonly workspaceEnabled: unknown;
  readonly fileWriteEnabled: unknown;
  readonly emergencyKillSwitch: unknown;
  readonly requestedOrgId: string;
  readonly requestedProjectId: string;
  readonly configuredOrgId: unknown;
  readonly configuredProjectId: unknown;
  readonly requestedExecutorId: string;
  readonly configuredExecutorId: unknown;
}

export type ExecutorEnablementDecision = {
  readonly allowed: boolean;
  readonly decision: 'allow_dry_run' | 'allow_live' | 'deny';
  readonly reason: string;
  readonly auditableInputs: Readonly<Record<string, unknown>>;
};

export function evaluateExecutorEnablement(input: ExecutorEnablementInput): ExecutorEnablementDecision {
  const audit = { ...input };
  if (input.mode === 'dry_run') return { allowed: true, decision: 'allow_dry_run', reason: 'dry-run has no external side effects', auditableInputs: audit };
  if (input.emergencyKillSwitch !== false) return { allowed: false, decision: 'deny', reason: 'emergency kill switch is enabled, missing, or malformed', auditableInputs: audit };
  if (input.requestedExecutorId !== 'file_write' || input.configuredExecutorId !== input.requestedExecutorId) return { allowed: false, decision: 'deny', reason: 'executor identity is not explicitly enabled', auditableInputs: audit };
  if (input.configuredOrgId !== input.requestedOrgId || input.configuredProjectId !== input.requestedProjectId) return { allowed: false, decision: 'deny', reason: 'workspace identity does not match enablement', auditableInputs: audit };
  const layers = [input.environmentAllowsExecutors, input.executorFamilyEnabled, input.workspaceEnabled, input.fileWriteEnabled];
  if (!layers.every((layer) => layer === true)) return { allowed: false, decision: 'deny', reason: 'all four live-enablement layers must be explicitly true', auditableInputs: audit };
  return { allowed: true, decision: 'allow_live', reason: 'all live-enablement layers explicitly allow execution', auditableInputs: audit };
}
