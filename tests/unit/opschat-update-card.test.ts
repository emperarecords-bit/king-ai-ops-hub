import { describe, expect, it } from 'vitest';
import { decisionsAfterRun, describeTaskState, type OwnerDecision, type TaskStateInput } from '@/domain/opschat/task-state';
import { PREPARE_UPDATE_CARD } from '@/domain/opschat/stale-wording';
import {
  APPROVED_DELIVERABLE_TYPES,
  approvedContent,
  buildUpdateInstructions,
  MAX_DISPATCH_INSTRUCTIONS,
  MAX_UPDATE_APPROVED,
  MAX_UPDATE_DECISIONS,
  normalizeJobTitle,
  UPDATE_CARD_TOO_BIG,
  updateTitle,
  type ApprovedChoice,
  type UpdateBasis,
  type UpdateDecision,
} from '@/domain/opschat/update-card';

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
    expect(s.ownerFacing).toContain(`Do not report the old result as current: ${PREPARE_UPDATE_CARD}`);
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
    expect(out).toContain(
      "- REJECTED (2026-10-19 17:19 UTC) — NOT chosen; do not use it or any figure or specification it describes: Reply to ONEAL regarding billing\n  Owner's note: Unrelated to this job.",
    );
    // No approved results → no approved section and no "settles it" sentence (output unchanged otherwise).
    expect(out).not.toContain('RESULTS THE OWNER APPROVED');
    expect(out).not.toContain('settle it');
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

  // Regression fixture (Hub prod, server-cooling, 2026-10-22): the update card carried the REJECTED 1,400 lb draft's note
  // but not the APPROVED shared-plenum draft eaeb0dd7, and the update run wrote "1,400 lb combined load".
  const approvedDraft: ApprovedChoice = {
    id: 'eaeb0dd7-05d8-4f7e-8cf0-1b01bc4173f7',
    taskId: 't1',
    at: at('2026-10-19T12:47:32Z'),
    summary: 'Save punch list to workspace',
    actionType: 'file_write',
    content: 'File punch_list_dual_fusion_tec.md:\nShared 36x18 plenum manifold.\nStructural rating: 2,500 lb.',
  };
  const rejectedDraft: UpdateDecision = {
    kind: 'approval_rejected',
    id: '12990c66',
    taskId: 't1',
    at: at('2026-10-19T12:47:35Z'),
    subject: 'Save punch list to workspace',
    detail: 'Duplicate punch list draft using independent per-unit ducting (1,400 lb rating) — owner chose the shared-duct version instead (approval eaeb0dd7).',
  };

  it('server-cooling: the APPROVED draft is carried verbatim as the chosen version; the rejected one is marked NOT chosen', () => {
    const out = ok(buildUpdateInstructions(basis({ approved: [approvedDraft] }, [rejectedDraft, q('q1', '2026-10-20T12:51:21Z', 'Lead-Lag or Parallel?', 'Lead-Lag (alternating)')])));
    const approvedAt = out.indexOf("=== RESULTS THE OWNER APPROVED (the owner's chosen version — build on these) ===");
    expect(approvedAt).toBeGreaterThan(out.indexOf('=== ORIGINAL INSTRUCTIONS ==='));
    expect(approvedAt).toBeLessThan(out.indexOf('=== OWNER DECISIONS SINCE THE PREVIOUS RUN'));
    expect(out).toContain(
      '- APPROVED (2026-10-19 12:47 UTC, approval eaeb0dd7-05d8-4f7e-8cf0-1b01bc4173f7): Save punch list to workspace\n  Approved content:\n    File punch_list_dual_fusion_tec.md:\n    Shared 36x18 plenum manifold.\n    Structural rating: 2,500 lb.',
    );
    expect(out).toContain('- REJECTED (2026-10-19 12:47 UTC) — NOT chosen; do not use it or any figure or specification it describes: Save punch list to workspace');
    expect(out).toContain('Where the original instructions leave a choice open, the approved results and the decisions above settle it.');
  });

  it('an approved document with no text content is named, never invented', () => {
    const out = ok(buildUpdateInstructions(basis({ approved: [{ ...approvedDraft, content: null }] }, [rejectedDraft])));
    expect(out).toContain("(The approval carries no text content to reproduce; it is the owner's chosen version — approval eaeb0dd7-05d8-4f7e-8cf0-1b01bc4173f7.)");
    expect(out).not.toContain('Approved content:');
  });

  it(`more than ${MAX_UPDATE_APPROVED} approved results → NO card (plain refusal)`, () => {
    const many5 = Array.from({ length: MAX_UPDATE_APPROVED + 1 }, (_, i) => ({ ...approvedDraft, id: `ap${i}` }));
    expect(buildUpdateInstructions(basis({ approved: many5 }, [rejectedDraft]))).toEqual({ ok: false, reason: 'too_many_decisions', message: UPDATE_CARD_TOO_BIG });
    expect(buildUpdateInstructions(basis({ approved: many5.slice(0, MAX_UPDATE_APPROVED) }, [rejectedDraft])).ok).toBe(true);
  });

  it('approvedContent: a saved document is verbatim and never shortened (credentials scrubbed); no text content → null', () => {
    const body = `line 1\n${'x'.repeat(9_000)}\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`;
    const file = approvedContent({ path: 'plan.md', content: body });
    expect(file!.startsWith('File plan.md:\nline 1\n')).toBe(true);
    expect(file!.length).toBeGreaterThan(9_000);
    expect(file).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(approvedContent({ content: 'no path' })).toBe('no path');
    expect(approvedContent({ path: 'x.bin', bytes: 12 })).toBeNull();
    expect(approvedContent(null)).toBeNull();
    expect(APPROVED_DELIVERABLE_TYPES).toEqual(['file_write']); // approving an email / HTTP action is not a design choice
  });

  it('updateTitle stays within the 200-char dispatch title limit', () => {
    expect(updateTitle('Duct CFM calc')).toBe('Duct CFM calc — updated with your answers');
    expect(updateTitle('T'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(updateTitle('T'.repeat(500)).endsWith(' — updated with your answers')).toBe(true);
  });
});

describe('owner-recorded decisions (chat facts that runs must see)', () => {
  const RUN = new Date('2026-10-22T01:59:56Z');
  const b = (over: Partial<UpdateBasis>, decisions: UpdateDecision[] = []): UpdateBasis => ({
    task: { id: 't1', title: 'Server Cabinet Cooling', input: 'Draft the punch list.', primaryAgentId: 'ag1' },
    run: { id: 'r1', status: 'completed', startedAt: RUN, finishedAt: new Date('2026-10-22T02:00:52Z') },
    siblings: [{ taskId: 't1', runId: 'r1', startedAt: RUN }],
    decisions,
    ...over,
  });
  const recorded: UpdateDecision = {
    kind: 'decision_recorded',
    id: 'd1',
    taskId: 't1',
    at: new Date('2026-10-22T03:00:00Z'),
    subject: 'Server cabinet heat load',
    detail: 'The single server cabinet produces 20 kW; size everything for that load.',
  };

  it('a decision recorded after the run is a DECISION line with its statement verbatim', () => {
    const r = buildUpdateInstructions(b({}, [recorded]));
    if (!r.ok) throw new Error(r.reason);
    expect(r.instructions).toContain(
      '- DECISION recorded by the owner (2026-10-22 03:00 UTC): Server cabinet heat load\n  The single server cabinet produces 20 kW; size everything for that load.',
    );
  });

  it('decisions recorded before the run are a standing-constraints section; "settles it" sentence appears', () => {
    const r = buildUpdateInstructions(
      b({ constraints: [{ id: 'c1', taskId: 't1', at: new Date('2026-10-19T12:40:11Z'), title: 'Duct choice', statement: 'Use the shared 36x18 plenum.' }] }, [recorded]),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.instructions).toContain('=== OWNER DECISIONS ALREADY RECORDED FOR THIS JOB (still apply) ===\n- Duct choice (recorded 2026-10-19 12:40 UTC): Use the shared 36x18 plenum.');
    expect(r.instructions.indexOf('ALREADY RECORDED')).toBeLessThan(r.instructions.indexOf('OWNER DECISIONS SINCE THE PREVIOUS RUN'));
    expect(r.instructions).toContain('the approved results and the decisions above settle it.');
  });

  it('describeTaskState counts recorded decisions in the stale sentence', () => {
    const s = describeTaskState({
      taskId: 't1',
      title: 'Server Cabinet Cooling',
      status: 'completed',
      job: null,
      run: { id: 'r1', status: 'completed', reviewOutcome: null, startedAt: RUN, finishedAt: new Date('2026-10-22T02:00:52Z'), resultChars: 10 },
      pendingApprovals: [],
      decisions: [
        { kind: 'question_answered', id: 'q1', at: new Date('2026-10-22T02:30:00Z'), summary: 'Q?' },
        { kind: 'decision_recorded', id: 'd1', at: new Date('2026-10-22T03:00:00Z'), summary: 'Server cabinet heat load' },
      ],
    });
    expect(s.ownerFacing).toContain('PREDATES 2 owner decisions made since (1 answered question and 1 recorded decision)');
    expect(s.stale!.decisions.map((d) => d.kind)).toEqual(['question_answered', 'decision_recorded']);
  });
});
