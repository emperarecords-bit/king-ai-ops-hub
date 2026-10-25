import { describe, expect, it } from 'vitest';
import { completedSince, describeLinkedRun, linkedRunLine, newestOwnerMessageAt, type LinkedRunFacts } from '@/domain/opschat/linked-run-view';
import { cardStateLines, type StoredCard } from '@/domain/opschat/card-state';
import { buildTranscript } from '@/app/ops/ops-chat-transcript';

/**
 * P5a — the outcome of the run an Ops Chat card started, worded only from the stored run/job rows that carry
 * the card's id (P4 links). DB-backed proofs: tests/integration/opschat-linked-runs.test.ts.
 */

const P = '7cc10bc8-0000-4000-8000-000000000001';
const TASK = '0a72c3bc-50cb-46f6-b0d6-5ce077f3e48e';
const RUN = 'a717c1ec-0000-4000-8000-000000000002';
const fin = new Date('2026-10-20T10:42:07Z');
const facts = (over: Partial<LinkedRunFacts> = {}, run: Partial<NonNullable<LinkedRunFacts['run']>> | null = {}): LinkedRunFacts => ({
  proposalId: P,
  taskId: TASK,
  job: { status: 'done', createdAt: new Date('2026-10-20T10:41:00Z'), updatedAt: fin },
  run:
    run === null
      ? null
      : { id: RUN, status: 'completed', reviewOutcome: 'reviewed', startedAt: new Date('2026-10-20T10:41:05Z'), finishedAt: fin, resultChars: 3948, errorMessage: null, ...run },
  pendingApprovals: 0,
  ...over,
});

describe('describeLinkedRun — one sentence, only from the linked rows', () => {
  it('completed + reviewed → ready, with the finish time', () => {
    const v = describeLinkedRun(facts());
    expect(v).toEqual({ taskId: TASK, runId: RUN, state: 'ready', finishedAt: fin.toISOString(), activeAt: fin.toISOString(), text: 'Finished 2026-10-20 10:42 UTC; its result is ready to read.' });
  });

  it('review required but unmet → UNREVIEWED DRAFT, never final', () => {
    const v = describeLinkedRun(facts({}, { reviewOutcome: 'required_unmet' }));
    expect(v.state).toBe('draft');
    expect(v.text).toBe('Finished 2026-10-20 10:42 UTC; its result is ready to read. It is an UNREVIEWED DRAFT: review was required but did not happen, so it is not final.');
  });

  it('a run that proposed approvals says they are waiting on the owner (the 16:10 case, now per card)', () => {
    expect(describeLinkedRun(facts({ pendingApprovals: 1 })).text).toMatch(/It proposed an approval that is waiting on the owner\.$/);
    expect(describeLinkedRun(facts({ pendingApprovals: 2 }))).toMatchObject({ state: 'needs_approval', text: expect.stringMatching(/It proposed 2 approvals that are waiting on the owner\.$/) });
  });

  it('completed with no result text is said plainly', () => {
    expect(describeLinkedRun(facts({}, { resultChars: 0 })).text).toBe('Finished 2026-10-20 10:42 UTC; it recorded no result text.');
  });

  it('failed → the stored reason, no result', () => {
    const v = describeLinkedRun(facts({}, { status: 'failed', errorMessage: 'provider timeout\n after 3 attempts' }));
    expect(v).toMatchObject({ state: 'failed', text: 'The run failed (2026-10-20 10:42 UTC): provider timeout after 3 attempts. No result was produced.' });
  });

  it('running / queued / picked up', () => {
    expect(describeLinkedRun(facts({}, { status: 'running', finishedAt: null })).text).toBe('Running now (started 2026-10-20 10:41 UTC).');
    expect(describeLinkedRun(facts({ job: { status: 'queued', createdAt: new Date('2026-10-20T10:41:00Z'), updatedAt: fin } }, null))).toMatchObject({
      state: 'queued',
      runId: null,
      text: 'Queued since 2026-10-20 10:41 UTC, not started yet.',
    });
    expect(describeLinkedRun(facts({ job: { status: 'running', createdAt: fin, updatedAt: fin } }, null)).state).toBe('running');
  });

  it('17:19 shape — a job that drained with NO run is never called a result', () => {
    const v = describeLinkedRun(facts({ job: { status: 'done', createdAt: fin, updatedAt: fin } }, null));
    expect(v).toMatchObject({ state: 'no_run', runId: null });
    expect(v.text).toBe('Its job ended (done, 2026-10-20 10:42 UTC) without a run on record — nothing was produced.');
  });

  it('linkedRunLine names the run and task by short id', () => {
    expect(linkedRunLine(describeLinkedRun(facts()))).toBe('linked run a717c1ec (task 0a72c3bc): Finished 2026-10-20 10:42 UTC; its result is ready to read.');
    expect(linkedRunLine(describeLinkedRun(facts({ job: { status: 'queued', createdAt: fin, updatedAt: fin } }, null)))).toMatch(/^linked job \(task 0a72c3bc\): Queued/);
  });
});

describe('completedSince — finished after the newest message, newest last', () => {
  const at = (iso: string, state: 'ready' | 'failed' | 'running' | 'queued' = 'ready') => ({
    taskId: TASK,
    runId: RUN,
    state,
    finishedAt: state === 'running' || state === 'queued' ? null : iso,
    text: state,
  });
  const newest = new Date('2026-10-20T10:00:00Z');

  it('keeps only runs that finished after the newest message, sorted by finish time', () => {
    const out = completedSince(
      [
        { proposalId: 'b', kind: 'rerun_task', label: 're-run "B"', view: at('2026-10-20T10:30:00Z', 'failed') },
        { proposalId: 'a', kind: 'dispatch_task', label: 'dispatch "A"', view: at('2026-10-20T10:10:00Z') },
        { proposalId: 'old', kind: 'dispatch_task', label: 'old', view: at('2026-10-20T09:59:59Z') },
        { proposalId: 'run', kind: 'dispatch_task', label: 'running', view: at('', 'running') },
        { proposalId: 'none', kind: 'dispatch_task', label: 'no link', view: undefined },
      ],
      newest,
    );
    expect(out.map((o) => o.proposalId)).toEqual(['a', 'b']);
  });

  it('review fix — the boundary is the newest OWNER message: a run that finished between the owner message (T1) and a later assistant reply (T3) is still listed', () => {
    const T1 = new Date('2026-10-20T10:00:00Z');
    const T2 = '2026-10-20T10:05:00.000Z';
    const T3 = new Date('2026-10-20T10:10:00Z');
    const messages = [
      { role: 'user', createdAt: new Date('2026-10-20T09:00:00Z') },
      { role: 'assistant', createdAt: new Date('2026-10-20T09:01:00Z') },
      { role: 'user', createdAt: T1 },
      { role: 'assistant', createdAt: T3 },
    ];
    const cards = [{ proposalId: 'a', kind: 'dispatch_task', label: 'dispatch "A"', view: at(T2) }];
    expect(newestOwnerMessageAt(messages)).toEqual(T1);
    expect(completedSince(cards, newestOwnerMessageAt(messages)).map((o) => o.proposalId)).toEqual(['a']);
    // The old boundary (newest message of either role) would have hidden it.
    expect(completedSince(cards, T3)).toEqual([]);
    // Unchanged: once the owner sends again (after T2), it is no longer "since your last message".
    expect(completedSince(cards, newestOwnerMessageAt([...messages, { role: 'user', createdAt: new Date('2026-10-20T10:11:00Z') }]))).toEqual([]);
  });

  it('no owner message yet → no boundary', () => {
    expect(newestOwnerMessageAt([{ role: 'assistant', createdAt: new Date() }])).toBeNull();
  });

  it('a conversation with no messages yet treats every finished run as new', () => {
    expect(completedSince([{ proposalId: 'a', kind: 'dispatch_task', label: 'A', view: at('2026-10-20T09:00:00Z') }], null)).toHaveLength(1);
  });
});

describe('cardStateLines with a linked run (prompt history)', () => {
  const at = new Date('2026-10-20T10:41:00Z');
  const card = (over: Partial<StoredCard>): StoredCard => ({ id: P, kind: 'rerun_task', state: 'done', proposal: { taskTitle: 'Duct CFM calc' }, result: null, error: null, updatedAt: at, ...over });

  it('a confirmed card with a linked run is "executed" and carries the run outcome from the run row', () => {
    const t = cardStateLines([card({ linkedRun: describeLinkedRun(facts({}, { reviewOutcome: 'required_unmet' })) })]);
    expect(t).toContain(
      '- [card rerun_task 7cc10bc8] re-run "Duct CFM calc" — CONFIRMED by the owner and executed — as of 2026-10-20 10:41 UTC — linked run a717c1ec (task 0a72c3bc): Finished 2026-10-20 10:42 UTC; its result is ready to read. It is an UNREVIEWED DRAFT',
    );
  });

  it('a linked job that drained with no run is executed-but-produced-nothing, never a result', () => {
    const t = cardStateLines([card({ linkedRun: describeLinkedRun(facts({ job: { status: 'done', createdAt: at, updatedAt: at } }, null)) })]);
    expect(t).toMatch(/linked job \(task 0a72c3bc\): Its job ended \(done, .*\) without a run on record — nothing was produced\./);
  });

  it('pre-0087 cards (no link) keep the existing wording exactly', () => {
    expect(cardStateLines([card({ linkedRun: null })])).toContain(
      `- [card rerun_task 7cc10bc8] re-run "Duct CFM calc" — CONFIRMED by the owner — no execution record (it did not record what it did; read the task's current state, do not assume it ran) — as of 2026-10-20 10:41 UTC`,
    );
  });

  it('a non-done card never shows a run line', () => {
    expect(cardStateLines([card({ state: 'pending', linkedRun: describeLinkedRun(facts()) })])).not.toMatch(/linked run/);
  });
});

describe('buildTranscript carries the linked run to the card', () => {
  it('only when the server sent one', () => {
    const view = describeLinkedRun(facts());
    const out = buildTranscript([
      { id: 'o1', role: 'user', status: 'complete', content: 'go', question: null, replyToMessageId: null, proposals: [] },
      {
        id: 'a1',
        role: 'assistant',
        status: 'complete',
        content: 'cards',
        question: null,
        replyToMessageId: 'o1',
        proposals: [
          { id: P, proposal: { kind: 'dispatch_task' }, state: 'done', result: null, error: null, linkedRun: view },
          { id: 'p2', proposal: { kind: 'dispatch_task' }, state: 'done', result: null, error: null, linkedRun: null },
        ],
      },
    ]);
    const cards = out.find((m) => m.id === 'a1')!.cards!;
    expect(cards[0]!.linkedRun).toEqual(view);
    expect('linkedRun' in cards[1]!).toBe(false);
  });
});
