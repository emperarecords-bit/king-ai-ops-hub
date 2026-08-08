import { describe, expect, it } from 'vitest';
import { canonicalizeFileWriteAction } from '@/domain/execution/file-write-action';
import { FakeSandbox } from '@/domain/execution/fake-sandbox';
import type { SandboxRequest, SandboxResult } from '@/domain/execution/sandbox-boundary';

const action = canonicalizeFileWriteAction({ operation: 'create', target: 'plans/a.md', payload: 'x' });
if (!action.allowed) throw new Error('fixture invalid');
const result: SandboxResult = { outcome: 'succeeded', outputBytes: 10, evidence: { sandboxId: 'sb-1', workspaceMountIdentity: 'mount-1', observedPostconditionSha256: action.action.desiredPostconditionSha256, atomicCommitObserved: true, cleanupState: 'complete', reconciliationRequired: false } };
const request: SandboxRequest = { sandboxId: 'sb-1', executionId: 'ex-1', workspaceMountIdentity: 'mount-1', targetPath: 'plans/a.md', action: action.action, limits: { timeoutMs: 1000, memoryBytes: 64 * 1024 * 1024, cpuMillis: 500, maxOutputBytes: 1024 } };

describe('isolated sandbox interface and fake', () => {
  it('returns configured in-memory evidence and records the contract request', async () => {
    const fake = new FakeSandbox(result);
    expect(await fake.execute(request, { cancelled: false, reason: null })).toEqual(result);
    expect(fake.requests).toEqual([request]);
  });
  it('supports cancellation without execution authority', async () => {
    expect((await new FakeSandbox(result).execute(request, { cancelled: true, reason: 'kill switch' })).outcome).toBe('cancelled');
  });
  it('rejects mismatched targets, invalid limits, and excessive output', async () => {
    await expect(new FakeSandbox(result).execute({ ...request, targetPath: 'plans/b.md' }, { cancelled: false, reason: null })).rejects.toThrow();
    await expect(new FakeSandbox(result).execute({ ...request, limits: { ...request.limits, timeoutMs: 0 } }, { cancelled: false, reason: null })).rejects.toThrow();
    await expect(new FakeSandbox({ ...result, outputBytes: 2048 }).execute(request, { cancelled: false, reason: null })).rejects.toThrow();
  });
});
