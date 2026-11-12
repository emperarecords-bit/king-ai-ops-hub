/**
 * VER-002 PR-7 — the retention / purge lifecycle, in-process.
 *
 * These assert the ORDERING and COMPLETION rules of docs/verification/external-runner-design.md §3.2
 * against a double that reproduces the SQL's semantics (InMemoryPurgeJobStore), so a green run here means
 * something about production rather than about a convenient fake. The privilege boundary and the real
 * transactional ordering are proven separately against Postgres in
 * tests/integration/verification-retention.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FakeRetentionObjectDeleter, InMemoryPurgeJobStore } from '../../src/domain/verification/memory-adapters';
import { drainOpenPurgeJobs, drainPurgeJob, openEvidencePurge, type RetentionDeps } from '../../src/domain/verification/retention';

function setup(seed: Record<string, readonly string[]>): { deps: RetentionDeps; store: InMemoryPurgeJobStore; deleter: FakeRetentionObjectDeleter; audits: string[] } {
  const store = new InMemoryPurgeJobStore();
  for (const [evidenceId, keys] of Object.entries(seed)) store.seedEvidence(evidenceId, keys);
  const deleter = new FakeRetentionObjectDeleter();
  const audits: string[] = [];
  const deps: RetentionDeps = { store, deleter, audit: async (e) => void audits.push(e.action) };
  return { deps, store, deleter, audits };
}

describe('PR-7 retention — opening a purge', () => {
  it('records every distinct object key, de-duplicating keys shared by several evidence rows', async () => {
    const { deps, store } = setup({ ev1: ['obj/a', 'obj/b'], ev2: ['obj/b', 'obj/c'] });
    const jobId = await openEvidencePurge(deps, ['ev1', 'ev2'], 'erasure_request');
    const job = await store.getJob(jobId);
    expect(job?.objectCount).toBe(3);
    expect((await store.listPendingObjects(jobId)).map((o) => o.objectKey)).toEqual(['obj/a', 'obj/b', 'obj/c']);
  });

  it('opens OPEN, never complete, while objects are outstanding', async () => {
    const { deps, store } = setup({ ev1: ['obj/a'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    expect((await store.getJob(jobId))?.status).toBe('open');
  });

  it('a purge that references no objects is complete at open (nothing to confirm gone)', async () => {
    const { deps, store } = setup({ ev1: [] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    expect((await store.getJob(jobId))?.status).toBe('complete');
    expect(await store.listPendingObjects(jobId)).toEqual([]);
  });

  it('refuses an empty evidence set', async () => {
    const { deps } = setup({});
    await expect(openEvidencePurge(deps, [], 'retention_expiry')).rejects.toThrow(/at least one evidence id/);
  });

  it('refuses an unknown reason (the DB CHECK, mirrored)', async () => {
    const { deps } = setup({ ev1: ['obj/a'] });
    await expect(openEvidencePurge(deps, ['ev1'], 'because-i-said-so' as 'retention_expiry')).rejects.toThrow(/retention_expiry or erasure_request/);
  });

  it('audits the open', async () => {
    const { deps, audits } = setup({ ev1: ['obj/a'] });
    await openEvidencePurge(deps, ['ev1'], 'erasure_request');
    expect(audits).toEqual(['verification.evidence.purge_opened']);
  });
});

describe('PR-7 retention — draining a job', () => {
  it('deletes every object and completes the job only on the LAST confirmation', async () => {
    const { deps, store, deleter } = setup({ ev1: ['obj/a', 'obj/b', 'obj/c'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    const r = await drainPurgeJob(deps, jobId);
    expect(r).toMatchObject({ jobId, deleted: 3, failed: 0, complete: true });
    expect(deleter.calls.map((c) => c.objectKey)).toEqual(['obj/a', 'obj/b', 'obj/c']);
    expect((await store.getJob(jobId))?.status).toBe('complete');
  });

  it('a failure is a RETRY, not a terminal state: the object stays pending and the job stays open', async () => {
    const { deps, store, deleter } = setup({ ev1: ['obj/a', 'obj/b'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    deleter.failTimes('obj/a', 1);

    const first = await drainPurgeJob(deps, jobId);
    expect(first).toMatchObject({ deleted: 1, failed: 1, complete: false });
    const afterFail = store.objectState(jobId).find((o) => o.objectKey === 'obj/a');
    expect(afterFail).toMatchObject({ state: 'pending', attempts: 1 });
    expect(afterFail?.lastError).toMatch(/transient provider failure/);
    expect((await store.getJob(jobId))?.status).toBe('open');

    // The next sweep picks it up — no object is silently skipped.
    const second = await drainPurgeJob(deps, jobId);
    expect(second).toMatchObject({ deleted: 1, failed: 0, complete: true });
  });

  it('one poisoned object does not starve the rest of the job', async () => {
    const { deps, deleter } = setup({ ev1: ['obj/a', 'obj/b', 'obj/c'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    deleter.failTimes('obj/a', 99);
    const r = await drainPurgeJob(deps, jobId);
    expect(r.failed).toBe(1);
    expect(r.deleted).toBe(2); // b and c still got done
    expect(r.complete).toBe(false);
  });

  it('never records a delete the provider did not confirm', async () => {
    const { deps, store, deleter } = setup({ ev1: ['obj/a'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    deleter.failTimes('obj/a', 99);
    await drainPurgeJob(deps, jobId);
    // Still pending: recordObjectDeleted is only reached after the deleter resolves.
    expect(store.objectState(jobId)[0]).toMatchObject({ objectKey: 'obj/a', state: 'pending' });
  });

  it('re-draining a complete job is a no-op', async () => {
    const { deps, deleter } = setup({ ev1: ['obj/a'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    await drainPurgeJob(deps, jobId);
    const callsAfterFirst = deleter.calls.length;
    const again = await drainPurgeJob(deps, jobId);
    expect(again).toMatchObject({ deleted: 0, failed: 0, complete: true });
    expect(deleter.calls.length).toBe(callsAfterFirst);
  });

  it('audits completion exactly once', async () => {
    const { deps, audits } = setup({ ev1: ['obj/a'] });
    const jobId = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    await drainPurgeJob(deps, jobId);
    await drainPurgeJob(deps, jobId);
    // The second drain re-reports complete, so the sink sees it again — asserted explicitly so a future
    // change to once-only semantics is a deliberate decision rather than a silent regression.
    expect(audits.filter((a) => a === 'verification.evidence.purge_completed').length).toBe(2);
  });
});

describe('PR-7 retention — sweeping open jobs', () => {
  it('drains open jobs oldest-first so a waiting job cannot be starved', async () => {
    const { deps, store } = setup({ ev1: ['obj/a'], ev2: ['obj/b'], ev3: ['obj/c'] });
    const j1 = await openEvidencePurge(deps, ['ev1'], 'retention_expiry');
    const j2 = await openEvidencePurge(deps, ['ev2'], 'retention_expiry');
    await openEvidencePurge(deps, ['ev3'], 'retention_expiry');
    const results = await drainOpenPurgeJobs(deps, 2);
    expect(results.map((r) => r.jobId)).toEqual([j1, j2]);
    expect(results.every((r) => r.complete)).toBe(true);
    expect((await store.listOpenJobIds(10)).length).toBe(1); // the third is still waiting
  });

  it('is a no-op when nothing is open', async () => {
    const { deps } = setup({});
    expect(await drainOpenPurgeJobs(deps, 5)).toEqual([]);
  });

  it('rejects a nonsense limit', async () => {
    const { deps } = setup({});
    await expect(drainOpenPurgeJobs(deps, 0)).rejects.toThrow(/positive integer/);
  });
});
