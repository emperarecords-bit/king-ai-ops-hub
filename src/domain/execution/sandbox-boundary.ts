import type { CanonicalFileWriteAction } from './file-write-action';

export interface SandboxResourceLimits {
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly cpuMillis: number;
  readonly maxOutputBytes: number;
}
export interface SandboxRequest {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly workspaceMountIdentity: string;
  readonly targetPath: string;
  readonly action: CanonicalFileWriteAction;
  readonly limits: SandboxResourceLimits;
}
export interface SandboxEvidence {
  readonly sandboxId: string;
  readonly workspaceMountIdentity: string;
  readonly observedPostconditionSha256: string | null;
  readonly atomicCommitObserved: boolean | null;
  readonly cleanupState: 'complete' | 'failed' | 'unknown';
  readonly reconciliationRequired: boolean;
}
export interface SandboxResult {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'ambiguous';
  readonly outputBytes: number;
  readonly evidence: SandboxEvidence;
}
export interface SandboxCancellation { readonly cancelled: boolean; readonly reason: string | null }
export interface IsolatedSandbox {
  execute(request: SandboxRequest, cancellation: SandboxCancellation): Promise<SandboxResult>;
}

export function validateSandboxRequest(request: SandboxRequest): void {
  if (request.targetPath !== request.action.normalizedTarget) throw new Error('sandbox target must match canonical action');
  for (const value of [request.limits.timeoutMs, request.limits.memoryBytes, request.limits.cpuMillis, request.limits.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('sandbox resource limits must be positive safe integers');
  }
}
