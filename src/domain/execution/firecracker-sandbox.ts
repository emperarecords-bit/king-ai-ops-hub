import {
  validateSandboxRequest,
  type IsolatedSandbox,
  type SandboxCancellation,
  type SandboxRequest,
  type SandboxResult,
} from './sandbox-boundary';

export interface FirecrackerCapabilities {
  readonly linux: boolean;
  readonly kvm: boolean;
  readonly firecrackerBinary: boolean;
}

export interface FirecrackerMachineSpec {
  readonly sandboxId: string;
  readonly vcpuCount: 1;
  readonly memoryBytes: number;
  readonly networkEnabled: false;
  readonly rootFilesystemReadOnly: true;
  readonly workspaceMount: {
    readonly guestPath: '/workspace';
    readonly identity: string;
    readonly readOnly: false;
  };
  readonly environment: Readonly<Record<string, never>>;
  readonly entrypoint: 'king-file-write-v1';
}

export interface FirecrackerMachine {
  readonly machineId: string;
}

/**
 * Platform boundary only. A production implementation must talk directly to
 * Firecracker; substituting a process or container runtime is not permitted.
 */
export interface FirecrackerControlPlane {
  capabilities(): Promise<FirecrackerCapabilities>;
  createMachine(spec: FirecrackerMachineSpec): Promise<FirecrackerMachine>;
  invokeFileWrite(machine: FirecrackerMachine, request: SandboxRequest): Promise<SandboxResult>;
  cancel(machine: FirecrackerMachine, reason: string): Promise<void>;
  destroy(machine: FirecrackerMachine): Promise<'complete' | 'failed' | 'unknown'>;
}

export class FirecrackerSandbox implements IsolatedSandbox {
  constructor(private readonly controlPlane: FirecrackerControlPlane) {}

  async execute(request: SandboxRequest, cancellation: SandboxCancellation): Promise<SandboxResult> {
    validateSandboxRequest(request);
    if (cancellation.cancelled) return cancelledResult(request);

    const capabilities = await this.controlPlane.capabilities();
    if (!capabilities.linux || !capabilities.kvm || !capabilities.firecrackerBinary) {
      throw new Error('Firecracker unavailable: Linux, KVM, and the Firecracker binary are required; fallback is prohibited');
    }

    const machine = await this.controlPlane.createMachine({
      sandboxId: request.sandboxId,
      vcpuCount: 1,
      memoryBytes: request.limits.memoryBytes,
      networkEnabled: false,
      rootFilesystemReadOnly: true,
      workspaceMount: { guestPath: '/workspace', identity: request.workspaceMountIdentity, readOnly: false },
      environment: {},
      entrypoint: 'king-file-write-v1',
    });

    let result: SandboxResult;
    let cleanupState: 'complete' | 'failed' | 'unknown';
    try {
      if (cancellation.cancelled) {
        await this.controlPlane.cancel(machine, cancellation.reason ?? 'cancelled');
        result = cancelledResult(request);
      } else {
        result = await this.controlPlane.invokeFileWrite(machine, request);
        validateResult(request, result);
      }
    } finally {
      cleanupState = await this.controlPlane.destroy(machine);
    }
    if (cleanupState !== 'complete') {
      return {
        ...result,
        outcome: 'ambiguous',
        evidence: { ...result.evidence, cleanupState, reconciliationRequired: true },
      };
    }
    return result;
  }
}

function validateResult(request: SandboxRequest, result: SandboxResult): void {
  if (result.evidence.sandboxId !== request.sandboxId) throw new Error('sandbox evidence identity mismatch');
  if (result.evidence.workspaceMountIdentity !== request.workspaceMountIdentity) throw new Error('workspace mount evidence identity mismatch');
  if (!Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0 || result.outputBytes > request.limits.maxOutputBytes) {
    throw new Error('sandbox output limit exceeded');
  }
}

function cancelledResult(request: SandboxRequest): SandboxResult {
  return {
    outcome: 'cancelled',
    outputBytes: 0,
    evidence: {
      sandboxId: request.sandboxId,
      workspaceMountIdentity: request.workspaceMountIdentity,
      observedPostconditionSha256: null,
      atomicCommitObserved: null,
      cleanupState: 'complete',
      reconciliationRequired: false,
    },
  };
}
