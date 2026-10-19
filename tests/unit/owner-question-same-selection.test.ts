import { describe, expect, it } from 'vitest';
import { sameSelectionWorkspaces, validateSameSelection } from '@/domain/questions/same-selection';
import { type OpenOwnerQuestion } from '@/domain/questions/questions';

/**
 * Owner-confirmed "these are the same" — pure selection guard. No DB: the input is exactly what
 * `openQuestionsForOwner` returns (already tenant-scoped and admin-filtered). Nothing here merges or
 * stores anything; the guard only decides which ids may be resolved together, one by one.
 */

let seq = 0;
function q(projectKey: string, question: string, at: string): OpenOwnerQuestion {
  seq += 1;
  return {
    questionId: `q-${seq}`,
    projectKey,
    workspaceName: projectKey === 'empera' ? 'Empera Air Conditioning and Heating' : projectKey,
    askedBy: 'Bookkeeper',
    question,
    createdAt: new Date(at),
  };
}

// Reworded repeats the strict text grouping cannot merge (the real v83 production shape).
const e1 = q('empera', 'When can you run the paper-records session?', '2026-09-05T09:01:00Z');
const e2 = q('empera', 'Ready to run the paper-records session now?', '2026-09-09T21:01:00Z');
const e3 = q('empera', 'Can you run the paper-records session for the 9 lines?', '2026-09-16T09:01:00Z');
const i1 = q('intl', 'Which supplier should we use?', '2026-09-06T10:00:00Z');
const i2 = q('intl', 'Confirm the Q4 budget?', '2026-09-07T10:00:00Z');
const a1 = q('accuratebids', 'Is the pricing page live?', '2026-09-01T10:00:00Z');

describe('sameSelectionWorkspaces', () => {
  it('offers only workspaces with two or more open questions, never mixing workspaces', () => {
    const ws = sameSelectionWorkspaces([e3, i2, a1, e1, i1, e2]);
    expect(ws.map((w) => w.projectKey)).toEqual(['empera', 'intl']);
    for (const w of ws) expect(new Set(w.questions.map((x) => x.projectKey))).toEqual(new Set([w.projectKey]));
  });

  it('orders questions oldest first within a workspace', () => {
    const [empera] = sameSelectionWorkspaces([e3, e1, e2]);
    expect(empera!.questions.map((x) => x.questionId)).toEqual([e1.questionId, e2.questionId, e3.questionId]);
    expect(empera!.workspaceName).toBe('Empera Air Conditioning and Heating');
  });

  it('offers nothing when no workspace has two questions', () => {
    expect(sameSelectionWorkspaces([a1, i1])).toEqual([]);
    expect(sameSelectionWorkspaces([])).toEqual([]);
  });
});

describe('validateSameSelection', () => {
  const [empera, intl] = sameSelectionWorkspaces([e1, e2, e3, i1, i2, a1]);

  it('accepts two or more questions from the workspace, de-duplicated, oldest first', () => {
    const r = validateSameSelection(empera!, [e3.questionId, e1.questionId, e3.questionId]);
    expect(r).toEqual({ ok: true, projectKey: 'empera', questionIds: [e1.questionId, e3.questionId] });
  });

  it('rejects fewer than two distinct questions', () => {
    expect(validateSameSelection(empera!, []).ok).toBe(false);
    expect(validateSameSelection(empera!, [e1.questionId]).ok).toBe(false);
    expect(validateSameSelection(empera!, [e1.questionId, e1.questionId]).ok).toBe(false);
  });

  it('rejects a question from another workspace (a selection never spans businesses)', () => {
    const r = validateSameSelection(empera!, [e1.questionId, i1.questionId]);
    expect(r.ok).toBe(false);
    const r2 = validateSameSelection(intl!, [i1.questionId, i2.questionId, e2.questionId]);
    expect(r2.ok).toBe(false);
  });

  it('rejects an id that is not an offered open question (stale or forged)', () => {
    const r = validateSameSelection(empera!, [e1.questionId, 'not-a-real-id']);
    expect(r).toEqual({ ok: false, error: 'A selected question is no longer open here. Reload the Inbox.' });
  });

  it('rejects a forged workspace whose questions claim a different projectKey', () => {
    const forged = { ...empera!, questions: [...empera!.questions, { ...i1 }] };
    const r = validateSameSelection(forged, [e1.questionId, i1.questionId]);
    expect(r).toEqual({ ok: false, error: 'A selection cannot span businesses.' });
  });
});
