import { describe, expect, it } from 'vitest';
import { canonicalizeFileWriteAction } from '@/domain/execution/file-write-action';
import {
  FirecrackerSandbox,
  type FirecrackerControlPlane,
  type FirecrackerMachine,
  type FirecrackerMachineSpec,
} from '@/domain/execution/firecracker-sandbox';
import type { SandboxRequest, SandboxResult } from '@/domain/execution/sandbox-boundary';

const canonical = canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.md', payload: 'safe' });
if (!canonical.allowed) throw new Error('fixture invalid');
const request: SandboxRequest = {
  sandboxId: 'sb-1', executionId: 'ex-1', workspaceMountIdentity: 'mount-1', targetPath: 'plans/a.md', action: canonical.action,
  limits: { timeoutMs: 10_000, memoryBytes: 128 * 1024 * 1024, cpuMillis: 2_000, maxOutputBytes: 64 * 1024 },
};
const success: SandboxResult = {
  outcome: 'succeeded', outputBytes: 64,
  evidence: { sandboxId: 'sb-1', workspaceMountIdentity: 'mount-1', observedPostconditionSha256: canonical.action.desiredPostconditionSha256, atomicCommitObserved: true, cleanupState: 'complete', reconciliationRequired: false },
};

class ControlPlaneFake implements FirecrackerControlPlane {
  specs: FirecrackerMachineSpec[] = [];
  invocations = 0;
  destroys = 0;
  cancels = 0;
  available = true;
  result = success;
  cleanup: 'complete' | 'failed' | 'unknown' = 'complete';
  async capabilities() { return { linux: this.available, kvm: this.available, firecrackerBinary: this.available }; }
  async createMachine(spec: FirecrackerMachineSpec) { this.specs.push(spec); return { machineId: 'vm-1' }; }
  async invokeFileWrite(_machine: FirecrackerMachine, _request: SandboxRequest) { this.invocations += 1; return this.result; }
  async cancel(_machine: FirecrackerMachine, _reason: string) { this.cancels += 1; }
  async destroy(_machine: FirecrackerMachine) { this.destroys += 1; return this.cleanup; }
}

describe('Firecracker sandbox adapter contract', () => {
  it('fails closed without Linux, KVM, and Firecracker and creates nothing', async () => {
    const control = new ControlPlaneFake(); control.available = false;
    await expect(new FirecrackerSandbox(control).execute(request, { cancelled: false, reason: null })).rejects.toThrow('fallback is prohibited');
    expect(control.specs).toEqual([]);
  });

  it('pins a fixed no-network microVM contract with only /workspace writable', async () => {
    const control = new ControlPlaneFake();
    await expect(new FirecrackerSandbox(control).execute(request, { cancelled: false, reason: null })).resolves.toEqual(success);
    expect(control.specs).toEqual([expect.objectContaining({
      networkEnabled: false, rootFilesystemReadOnly: true, environment: {}, entrypoint: 'king-file-write-v1',
      workspaceMount: { guestPath: '/workspace', identity: 'mount-1', readOnly: false },
    })]);
    expect(control.invocations).toBe(1);
    expect(control.destroys).toBe(1);
  });

  it('does not allocate a machine when already cancelled', async () => {
    const control = new ControlPlaneFake();
    expect((await new FirecrackerSandbox(control).execute(request, { cancelled: true, reason: 'kill switch' })).outcome).toBe('cancelled');
    expect(control.specs).toEqual([]);
  });

  it('rejects forged evidence and excessive output while still destroying the VM', async () => {
    const control = new ControlPlaneFake();
    control.result = { ...success, evidence: { ...success.evidence, workspaceMountIdentity: 'other' } };
    await expect(new FirecrackerSandbox(control).execute(request, { cancelled: false, reason: null })).rejects.toThrow('identity mismatch');
    expect(control.destroys).toBe(1);
    control.result = { ...success, outputBytes: request.limits.maxOutputBytes + 1 };
    await expect(new FirecrackerSandbox(control).execute(request, { cancelled: false, reason: null })).rejects.toThrow('output limit exceeded');
    expect(control.destroys).toBe(2);
  });

  it('marks a valid result ambiguous when VM cleanup cannot be proven', async () => {
    const control = new ControlPlaneFake(); control.cleanup = 'unknown';
    const result = await new FirecrackerSandbox(control).execute(request, { cancelled: false, reason: null });
    expect(result).toEqual(expect.objectContaining({ outcome: 'ambiguous', evidence: expect.objectContaining({ cleanupState: 'unknown', reconciliationRequired: true }) }));
  });
});
