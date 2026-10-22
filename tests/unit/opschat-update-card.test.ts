import { describe, expect, it } from 'vitest';
import { decisionsAfterRun, describeTaskState, type OwnerDecision, type TaskStateInput } from '@/domain/opschat/task-state';
import { buildUpdateInstructions, MAX_DISPATCH_INSTRUCTIONS, MAX_UPDATE_DECISIONS, normalizeJobTitle, UPDATE_CARD_TOO_BIG, updateTitle, type UpdateBasis, type UpdateDecision } from '@/domain/opschat/update-card';

/**
 * P5c-2 — stale work: the latest run predates owner decisions made after it started; the Hub offers ONE update card
 * with those decisions written into the new run's instructions. DB/tool proofs: tests/integration/opschat-update-card.test.ts.
 */

const RUN_START = new Date('2026-10-19T14:50:03Z');
const at = (iso: string) => new Date(iso);
const dec = (kind: OwnerDecision['kind'], id: string, iso: string, summary = `decision ${id}`): OwnerDecision => ({ kind, id, at: at(iso), summary });

describe('decisionsAfterRun', () => {
  it('keeps only decisions after the run STARTED, oldest first; no run → none', () => {
    const ds = [dec('question_answered', 'late', '2026-10-19T17:00:00Z'), dec('question_answered', 'early', '2026-10-19T14:00:00Z'), dec('approval_rejected', 'mid', '2026-10-19T16:00:00Z')];
    expect(decisionsAfterRun(RUN_START, ds).map((d) => d.id)).toEqual(['mid', 'late']);
    expect(decisionsAfterRun(null, ds)).toEqual([]);
    // Decided while the run was still running → it was not in the run's context → counts.
    expect(decisionsAfterRun(RUN_START, [dec('question_answered', 'during', '2026-10-19T14:50:05Z')])).toHaveLength(1);
  });
});

describe('describeTaskState — stale / superseded', () => {
  const base: TaskStateInput = {
    taskId: 't1',
    title: 'Duct CFM calc',
    status: 'completed',
    job: null,
    run: { id: 'r1', status: 'completed', reviewOutcome: 'required_unmet', startedAt: RUN_START, finishedAt: at('2026-10-19T14:50:11Z'), resultChars: 3948 },
    pendingApprovals: [],
  };

  it('four blockers answered after the run → STALE with the counts, and the update-card nudge', () => {
    const s = describeTaskState({
      ...base,
      decisions: [
        dec('question_answered', 'q1', '2026-10-19T17:01:00Z', 'What supply-air temperature?'),
        dec('question_answered', 'q2', '2026-10-19T17:02:00Z'),
        dec('question_answered', 'q3', '2026-10-19T17:03:00Z'),
        dec('question_answered', 'q4', '2026-10-19T17:04:00Z'),
        dec('approval_rejected', 'a1', '2026-10-19T17:19:00Z'),
        dec('question_answered', 'old', '2026-10-19T13:00:00Z'),
      ],
    });
    expect(s.stale).toMatchObject({ runId: 'r1', runStartedAt: RUN_START.toISOString() });
    expect(s.stale!.decisions.map((d) => d.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'a1']);
    expect(s.ownerFacing).toContain('Its latest run (started 2026-10-19 14:50 UTC) PREDATES 5 owner decisions made since (4 answered questions and 1 rejected approval) — its result does not reflect them.');
    expect(s.ownerFacing).toContain('Offer ONE update card (propose_update_task)');
    expect(s.ownerFacing).toMatch(/UNREVIEWED DRAFT/); // the existing truth stays
    expect(s.supersededBy).toBeNull();
  });

  it('decisions only before the run, or no run at all → not stale', () => {
    expect(describeTaskState({ ...base, decisions: [dec('question_answered', 'old', '2026-10-19T13:00:00Z')] }).stale).toBeNull();
    expect(describeTaskState({ ...base, run: null, status: 'pending', decisions: [dec('question_answered', 'x', '2026-10-19T17:00:00Z')] }).stale).toBeNull();
  });

  it('an update task created after the run and after every decision → SUPERSEDED, not stale (no endless update offers)', () => {
    const s = describeTaskState({
      ...base,
      decisions: [dec('question_answered', 'q1', '2026-10-19T17:01:00Z')],
      supersededBy: { taskId: 't2', title: 'Duct CFM calc — updated with your answers', createdAt: at('2026-10-19T17:30:00Z') },
    });
    expect(s.stale).toBeNull();
    expect(s.supersededBy).toEqual({ taskId: 't2', title: 'Duct CFM calc — updated with your answers', createdAt: '2026-10-19T17:30:00.000Z' });
    expect(s.ownerFacing).toContain('SUPERSEDED by update task "Duct CFM calc — updated with your answers" (t2');
  });

  it('a decision made AFTER the update task was created makes the old task stale again; a re-run after the update clears "superseded"', () => {
    const sup = { taskId: 't2', title: 'upd', createdAt: at('2026-10-19T17:30:00Z') };
    const later = describeTaskState({ ...base, decisions: [dec('question_answered', 'q9', '2026-10-19T18:00:00Z')], supersededBy: sup });
    expect(later.stale).not.toBeNull();
    expect(later.supersededBy).toBeNull();
    const rerun = describeTaskState({ ...base, run: { ...base.run!, id: 'r2', startedAt: at('2026-10-19T19:00:00Z') }, supersededBy: sup });
    expect(rerun.supersededBy).toBeNull();
    expect(rerun.stale).toBeNull();
  });
});

describe('buildUpdateInstructions / updateTitle', () => {
  const basis = (over: Partial<UpdateBasis> = {}, decisions: UpdateDecision[] = []): UpdateBasis => ({
    task: { id: 't1', title: 'Server Cabinet Cooling — duct sizing', input: 'Size the supply and return ducts for the server cabinet.', primaryAgentId: 'ag1' },
    run: { id: 'r1', status: 'completed', startedAt: RUN_START, finishedAt: at('2026-10-19T14:50:11Z') },
    siblings: [{ taskId: 't1', runId: 'r1', startedAt: RUN_START }],
    decisions,
    ...over,
  });
  const q = (id: string, iso: string, question: string, answer: string): UpdateDecision => ({ kind: 'question_answered', id, taskId: 't1', at: at(iso), subject: question, detail: answer });

  const ok = (r: ReturnType<typeof buildUpdateInstructions>): string => {
    if (!r.ok) throw new Error(`expected a card, got refusal: ${r.reason}`);
    return r.instructions;
  };
  const many = (n: number) => Array.from({ length: n }, (_, i) => q(`q${i}`, `2026-10-19T17:${String(10 + i).padStart(2, '0')}:00Z`, `Blocker ${i}: value?`, `ANSWER-${i}-CONTENT`));

  it('original instructions + every decision verbatim + what to do', () => {
    const out = ok(
      buildUpdateInstructions(
        basis({}, [
          q('q1', '2026-10-19T17:01:00Z', 'What supply-air temperature should I assume?', '55°F'),
          q('q2', '2026-10-19T17:02:00Z', 'Is the cabinet sealed?', 'Yes, fully sealed with a rear door.'),
          { kind: 'approval_rejected', id: 'a1', taskId: 't1', at: at('2026-10-19T17:19:00Z'), subject: 'Reply to ONEAL regarding billing', detail: 'Unrelated to this job.' },
        ]),
      ),
    );
    expect(out.startsWith('=== ORIGINAL INSTRUCTIONS ===\nSize the supply and return ducts for the server cabinet.')).toBe(true);
    expect(out).toContain("- Question (answered 2026-10-19 17:01 UTC): What supply-air temperature should I assume?\n  Owner's answer: 55°F");
    expect(out).toContain("Owner's answer: Yes, fully sealed with a rear door.");
    expect(out).toContain("- REJECTED (2026-10-19 17:19 UTC): Reply to ONEAL regarding billing\n  Owner's note: Unrelated to this job.");
    expect(out).toContain('The previous run of "Server Cabinet Cooling — duct sizing" (run r1, started 2026-10-19 14:50 UTC) predates the decisions above.');
    expect(out).toMatch(/Do not re-ask questions that are answered above; do not repeat a proposal the owner rejected\.$/);
  });

  it(`1. exactly ${MAX_UPDATE_DECISIONS} decisions → a card, with ALL ${MAX_UPDATE_DECISIONS} contents present`, () => {
    const out = ok(buildUpdateInstructions(basis({}, many(MAX_UPDATE_DECISIONS))));
    for (let i = 0; i < MAX_UPDATE_DECISIONS; i++) {
      expect(out).toContain(`Blocker ${i}: value?`);
      expect(out).toContain(`ANSWER-${i}-CONTENT`);
    }
    expect(out).not.toMatch(/more decisions|truncated|\[…\]/);
  });

  it(`2. ${MAX_UPDATE_DECISIONS + 1} decisions → NO card: a plain refusal, nothing summarized`, () => {
    const r = buildUpdateInstructions(basis({}, many(MAX_UPDATE_DECISIONS + 1)));
    expect(r).toEqual({ ok: false, reason: 'too_many_decisions', message: UPDATE_CARD_TOO_BIG });
    expect(UPDATE_CARD_TOO_BIG).toBe(
      'This job has too many post-run owner decisions to fit safely into one update card without dropping content. Nothing was prepared. Narrow the update scope or create a fresh consolidated task.',
    );
  });

  it('nothing is ever shortened: long and multi-line answers are kept whole; if the COMPLETE text cannot fit the limit → no card', () => {
    const long = 'L'.repeat(6_000);
    const kept = ok(buildUpdateInstructions(basis({}, [q('q1', '2026-10-19T17:01:00Z', 'Table?', `row1\nrow2\n${long}`)])));
    expect(kept).toContain(`Owner's answer: row1\n    row2\n    ${long}`); // line breaks kept (indented), not reflowed
    expect(kept.length).toBeLessThanOrEqual(MAX_DISPATCH_INSTRUCTIONS);
    // Too large in total (answers or original) → refused, never truncated.
    expect(buildUpdateInstructions(basis({}, many(5).map((d) => ({ ...d, detail: 'A'.repeat(8_000) }))))).toMatchObject({ ok: false, reason: 'too_large' });
    expect(buildUpdateInstructions(basis({ task: { ...basis().task, input: 'x'.repeat(31_900) } }, many(1)))).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('P5c-2b: normalizeJobTitle — case/whitespace-insensitive identity of one job', () => {
    expect(normalizeJobTitle('  Server Cabinet Cooling —  Dual FUSION-TEC\tPunch List ')).toBe('server cabinet cooling — dual fusion-tec punch list');
    expect(normalizeJobTitle('A b')).not.toBe(normalizeJobTitle('A bc'));
  });

  it('P5c-2b: a card for a job dispatched twice says so and carries the decisions made on EITHER task', () => {
    const out = ok(
      buildUpdateInstructions(
        basis(
          { siblings: [{ taskId: 'tA', runId: 'rA', startedAt: RUN_START }, { taskId: 't1', runId: 'r1', startedAt: RUN_START }] },
          [
            { ...q('qA', '2026-10-20T12:51:21Z', 'Lead-Lag or Primary-Standby?', 'Lead-Lag (alternating)'), taskId: 'tA' },
            q('q1', '2026-10-21T05:34:02Z', 'Fire suppression interface?', 'None needed'),
          ],
        ),
      ),
    );
    expect(out).toContain('This job was dispatched 2 times under this title (tasks tA, t1); the decisions above were made on any of them and ALL apply.');
    expect(out).toContain("Owner's answer: Lead-Lag (alternating)");
    expect(out).toContain("Owner's answer: None needed");
    expect(ok(buildUpdateInstructions(basis({}, [q('q1', '2026-10-21T05:34:02Z', 'Q?', 'A')])))).not.toContain('dispatched');
  });

  it('updateTitle stays within the 200-char dispatch title limit', () => {
    expect(updateTitle('Duct CFM calc')).toBe('Duct CFM calc — updated with your answers');
    expect(updateTitle('T'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(updateTitle('T'.repeat(500)).endsWith(' — updated with your answers')).toBe(true);
  });
});
