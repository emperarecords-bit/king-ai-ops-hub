import { describe, expect, it } from 'vitest';
import { describeTaskState, type TaskStateInput } from '@/domain/opschat/task-state';
import { cardStateLines, type StoredCard } from '@/domain/opschat/card-state';
import { pickDispatchReviewer, resolveDispatchAgent } from '@/domain/opschat/dispatch-agent';

/**
 * Pure halves of Ops Chat truthful state (server-cooling evidence, Hub prod 2026-10-19). The DB-backed proofs
 * are tests/integration/ops-chat-truthful-state.test.ts.
 */

const base: TaskStateInput = { taskId: 't', title: 'Duct CFM calc', status: 'pending', job: null, run: null, pendingApprovals: [] };
const run = (over: Partial<NonNullable<TaskStateInput['run']>> = {}) => ({
  id: 'r1', status: 'completed', reviewOutcome: null, startedAt: new Date('2026-10-19T14:50:03Z'), finishedAt: new Date('2026-10-19T14:50:11Z'), resultChars: 3948, ...over,
});

describe('describeTaskState — one sentence, only from stored facts', () => {
  it('16:10 case: awaiting_approval after a completed run = ALREADY RAN, result ready, waiting on the named approval (not an unconfirmed card)', () => {
    const s = describeTaskState({
      ...base,
      status: 'awaiting_approval',
      run: run({ reviewOutcome: 'required_unmet' }),
      pendingApprovals: [{ id: 'edb61199', summary: 'Reply to ONEAL regarding billing/subscription access', actionType: 'external_http', createdAt: new Date() }],
    });
    expect(s.ownerFacing).toBe(
      'It already RAN (finished 2026-10-19 14:50 UTC) and its result is ready to read. It is waiting on the owner\'s decision on approval "Reply to ONEAL regarding billing/subscription access" (edb61199) that the run proposed — this is NOT an unconfirmed card.',
    );
  });

  it('completed with review required but unmet = UNREVIEWED DRAFT, not final', () => {
    expect(describeTaskState({ ...base, status: 'completed', run: run({ reviewOutcome: 'required_unmet' }) }).ownerFacing).toMatch(
      /Completed 2026-10-19 14:50 UTC; result available\. It is an UNREVIEWED DRAFT: .* not final\./,
    );
    expect(describeTaskState({ ...base, status: 'completed', run: run({ reviewOutcome: 'reviewed' }) }).ownerFacing).not.toMatch(/UNREVIEWED/);
  });

  it('pending: queued vs stuck are told apart', () => {
    expect(describeTaskState({ ...base, job: { status: 'queued', createdAt: new Date('2026-10-19T17:19:52Z'), updatedAt: new Date() } }).ownerFacing).toMatch(
      /^Queued, not started yet \(job queued since 2026-10-19 17:19 UTC\)\.$/,
    );
    expect(describeTaskState({ ...base, job: { status: 'done', createdAt: new Date(), updatedAt: new Date() } }).ownerFacing).toMatch(/NO job queued — it will not start on its own/);
  });

  it('running / failed / cancelled', () => {
    expect(describeTaskState({ ...base, status: 'running', run: run({ status: 'running', finishedAt: null }) }).ownerFacing).toMatch(/^Running now \(started 2026-10-19 14:50 UTC\)\.$/);
    expect(describeTaskState({ ...base, status: 'failed', run: run({ status: 'failed' }) }).ownerFacing).toMatch(/^Failed/);
    expect(describeTaskState({ ...base, status: 'cancelled' }).ownerFacing).toBe('Cancelled.');
  });
});

describe('cardStateLines — 22:36 case', () => {
  const at = new Date('2026-10-19T17:19:49Z');
  const card = (over: Partial<StoredCard>): StoredCard => ({ kind: 'rerun_task', state: 'done', proposal: {}, result: null, error: null, updatedAt: at, ...over });

  it('two CONFIRMED cards are stated as confirmed, authoritative over the reply text', () => {
    const t = cardStateLines([
      card({ kind: 'decide_approval', proposal: { approvalId: 'edb61199', decision: 'rejected' } }),
      card({ proposal: { taskTitle: 'Duct CFM calc' }, result: { outcome: 'started', taskId: '0a72c3bc', jobId: 'job-2' } }),
    ]);
    expect(t).toContain('[SERVER RECORD — current state of the cards in this reply; authoritative over anything said above]');
    expect(t).toContain('- [card decide_approval] rejected approval edb61199 — CONFIRMED by the owner — rejection recorded — as of 2026-10-19 17:19 UTC');
    expect(t).toContain('- [card rerun_task] re-run "Duct CFM calc" — CONFIRMED by the owner and executed — as of 2026-10-19 17:19 UTC (taskId 0a72c3bc, jobId job-2, outcome started)');
  });

  it('17:19 regression — a CONFIRMED re-run card with NO stored result is never called "executed"', () => {
    // Exact production shape: proposal 7cc10bc8 (rerun_task 0a72c3bc) is 'done' with result NULL — before #168 its
    // job drained with no run. v89 acceptance: Ops Chat called it "the same completed-but-unreviewed run".
    const t = cardStateLines([card({ proposal: { taskId: '0a72c3bc-50cb-46f6-b0d6-5ce077f3e48e', taskTitle: 'Duct CFM calc' }, result: null })]);
    expect(t).toContain(
      `- [card rerun_task] re-run "Duct CFM calc" — CONFIRMED by the owner — no execution record (it did not record what it did; read the task's current state, do not assume it ran) — as of 2026-10-19 17:19 UTC`,
    );
    expect(t).not.toMatch(/and executed/);
  });

  it(`"executed" only with evidence: an outcome or job id, or a dispatch's created task id`, () => {
    expect(cardStateLines([card({ result: { outcome: 'already_queued', jobId: 'j' } })])).toMatch(/CONFIRMED by the owner and executed/);
    expect(cardStateLines([card({ kind: 'dispatch_task', proposal: { title: 'X' }, result: { taskId: 't1' } })])).toMatch(/CONFIRMED by the owner and executed/);
    expect(cardStateLines([card({ kind: 'dispatch_task', proposal: { title: 'X' }, result: null })])).toMatch(/no execution record/);
    expect(cardStateLines([card({ kind: 'decide_approval', proposal: { approvalId: 'a', decision: 'approved' }, result: { message: null, outcome: null } })])).toMatch(
      /approval recorded; no execution record/,
    );
    expect(cardStateLines([card({ kind: 'answer_question', proposal: { questionId: 'q' }, result: null })])).toMatch(/answer recorded/);
  });

  it('pending / cancelled / stale (with reason) are each stated plainly; no cards → nothing appended', () => {
    expect(cardStateLines([card({ state: 'pending' })])).toMatch(/NOT confirmed — still waiting for the owner/);
    expect(cardStateLines([card({ state: 'cancelled' })])).toMatch(/CANCELLED by the owner — nothing was done/);
    expect(cardStateLines([card({ state: 'stale', error: '"T" is waiting on an approval decision.' })])).toMatch(/STALE — not executed: "T" is waiting/);
    expect(cardStateLines([])).toBe('');
  });
});

describe('resolveDispatchAgent / pickDispatchReviewer', () => {
  const A = [
    { id: 'ml', name: 'Marketing Lead', role: 'primary', enabled: true },
    { id: 'ra', name: 'Research Analyst', role: 'primary', enabled: true },
    { id: 'off', name: 'Research Assistant', role: 'primary', enabled: false },
    { id: 'rv', name: 'Reviewer', role: 'reviewer', enabled: true },
  ];

  it('no silent default when several primaries exist (the 11:41 Marketing Lead pick)', () => {
    const r = resolveDispatchAgent(A, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toEqual(['Marketing Lead', 'Research Analyst']);
  });

  it('exact, case-insensitive, unique-partial, and id matches; disabled and reviewer agents never own a task', () => {
    expect(resolveDispatchAgent(A, 'research analyst')).toMatchObject({ ok: true, agent: { id: 'ra' } });
    expect(resolveDispatchAgent(A, 'Research')).toMatchObject({ ok: true, agent: { id: 'ra' } }); // disabled Assistant excluded
    expect(resolveDispatchAgent(A, 'ml')).toMatchObject({ ok: true, agent: { id: 'ml' } });
    expect(resolveDispatchAgent(A, 'Reviewer').ok).toBe(false);
    expect(resolveDispatchAgent([...A, { id: 'rx', name: 'Research Lead', role: 'primary', enabled: true }], 'Research').ok).toBe(false); // ambiguous
  });

  it('a single primary needs no name; the reviewer pick is the enabled reviewer or null', () => {
    expect(resolveDispatchAgent([A[1]!], undefined)).toMatchObject({ ok: true, agent: { id: 'ra' } });
    expect(pickDispatchReviewer(A)?.id).toBe('rv');
    expect(pickDispatchReviewer(A.slice(0, 2))).toBeNull();
  });
});
