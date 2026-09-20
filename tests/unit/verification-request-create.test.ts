import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVerificationRequest, type VerificationRequestInput } from '@/domain/verification';
import { InMemoryVerificationStore } from '@/domain/verification/memory-adapters';

const ORG = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const USER = randomUUID();
const TASK = randomUUID();
const COMMIT = 'a'.repeat(40);
const ctx = { orgId: ORG, projectId: PROJECT, userId: USER };

function storeWithTask(): InMemoryVerificationStore {
  const s = new InMemoryVerificationStore();
  s.addTask(ORG, PROJECT, TASK);
  return s;
}
const validInput = (over: Partial<VerificationRequestInput> = {}): VerificationRequestInput => ({
  taskId: TASK,
  repoFullName: 'acme/widget',
  commitSha: COMMIT,
  requiredChecks: ['unit', 'typecheck'],
  requiredArtifacts: ['test-results.json'],
  ...over,
});

describe('createVerificationRequest — contract creation', () => {
  it('creates a contract bound to the authenticated tenant + creator (never the payload)', async () => {
    const store = storeWithTask();
    const out = await createVerificationRequest(store, ctx, validInput());
    expect(out.created).toBe(true);
    expect(out.rejection).toBeNull();
    const r = out.request!;
    expect(r.orgId).toBe(ORG);
    expect(r.projectId).toBe(PROJECT);
    expect(r.createdBy).toBe(USER);
    expect(r.taskId).toBe(TASK);
    expect(r.repoFullName).toBe('acme/widget');
    expect(r.expectedCommitSha).toBe(COMMIT);
    expect([...r.requiredChecks].sort()).toEqual(['typecheck', 'unit']);
    expect(r.requiredArtifacts).toEqual(['test-results.json']);
    expect(r.allowDirty).toBe(false);
  });

  it('is idempotent: an identical re-create returns the SAME contract, does not duplicate', async () => {
    const store = storeWithTask();
    const first = await createVerificationRequest(store, ctx, validInput());
    const again = await createVerificationRequest(store, ctx, validInput({ requiredChecks: ['typecheck', 'unit'] }));
    expect(again.created).toBe(false);
    expect(again.rejection).toBeNull();
    expect(again.request!.id).toBe(first.request!.id);
  });

  it('REJECTS a conflicting re-create (same task+commit, different contract) — never silently alters', async () => {
    const store = storeWithTask();
    await createVerificationRequest(store, ctx, validInput());
    const conflict = await createVerificationRequest(store, ctx, validInput({ requiredChecks: ['unit'] }));
    expect(conflict.created).toBe(false);
    expect(conflict.request).toBeNull();
    expect(conflict.rejection?.code).toBe('contract_conflict');
    // A different required-artifacts set is also a conflict.
    const conflict2 = await createVerificationRequest(store, ctx, validInput({ requiredArtifacts: ['other.json'] }));
    expect(conflict2.rejection?.code).toBe('contract_conflict');
  });

  it('a different commit for the same task is a NEW contract (not a conflict)', async () => {
    const store = storeWithTask();
    await createVerificationRequest(store, ctx, validInput());
    const other = await createVerificationRequest(store, ctx, validInput({ commitSha: 'b'.repeat(40) }));
    expect(other.created).toBe(true);
    expect(other.rejection).toBeNull();
  });

  it('rejects a task that is not in this project (tenant-scoped)', async () => {
    const store = storeWithTask(); // task exists only in (ORG, PROJECT)
    // Same task id, but the caller is acting in OTHER_PROJECT where the task does not exist.
    const out = await createVerificationRequest(store, { ...ctx, projectId: OTHER_PROJECT }, validInput());
    expect(out.rejection?.code).toBe('task_not_in_project');
    expect(out.request).toBeNull();
  });

  it('rejects invalid input up front (before any tenant/task check)', async () => {
    const store = storeWithTask();
    const cases: Array<[string, VerificationRequestInput]> = [
      ['non-uuid task', validInput({ taskId: 'not-a-uuid' })],
      ['short commit', validInput({ commitSha: 'abc123' })],
      ['non-hex commit', validInput({ commitSha: 'z'.repeat(40) })],
      ['no checks', validInput({ requiredChecks: [] })],
      ['blank-only checks', validInput({ requiredChecks: ['   '] })],
      ['duplicate checks', validInput({ requiredChecks: ['unit', 'unit'] })],
      ['bad repo', validInput({ repoFullName: 'no-slash' })],
    ];
    for (const [label, input] of cases) {
      const out = await createVerificationRequest(store, ctx, input);
      expect(out.rejection?.code, label).toBe('invalid_input');
      expect(out.request, label).toBeNull();
    }
  });

  it('normalizes the commit to lower-case and trims list entries', async () => {
    const store = storeWithTask();
    const out = await createVerificationRequest(
      store,
      ctx,
      validInput({ commitSha: 'A'.repeat(40), requiredChecks: [' unit ', 'lint'] }),
    );
    expect(out.created).toBe(true);
    expect(out.request!.expectedCommitSha).toBe('a'.repeat(40));
    expect([...out.request!.requiredChecks].sort()).toEqual(['lint', 'unit']);
  });
});
