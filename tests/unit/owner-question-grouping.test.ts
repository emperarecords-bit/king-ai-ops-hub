import { describe, expect, it } from 'vitest';
import { groupOpenQuestions, normalizeQuestionText } from '@/domain/questions/grouping';
import { type OpenOwnerQuestion } from '@/domain/questions/questions';

/**
 * Inbox duplicate grouping — pure, read-time, display-only. No DB: the input is
 * exactly what `openQuestionsForOwner` returns (already tenant-scoped and admin-filtered).
 */

let seq = 0;
function q(
  projectKey: string,
  question: string,
  at: string,
  overrides: Partial<OpenOwnerQuestion> = {},
): OpenOwnerQuestion {
  seq += 1;
  return {
    questionId: `q-${seq}`,
    projectKey,
    workspaceName: projectKey === 'empera' ? 'Empera Air Conditioning and Heating' : projectKey,
    askedBy: 'Bookkeeper',
    question,
    createdAt: new Date(at),
    ...overrides,
  };
}

describe('normalizeQuestionText', () => {
  it('trims, lowercases and collapses whitespace', () => {
    expect(normalizeQuestionText('  What   is the\tQuickBooks\n login?  ')).toBe('what is the quickbooks login');
  });

  it('ignores trailing punctuation and curly vs straight quotes', () => {
    expect(normalizeQuestionText('Is the “Main” account the operating account?')).toBe(
      normalizeQuestionText('is the "Main" account the operating account'),
    );
    expect(normalizeQuestionText('Who’s the CPA?!')).toBe("who's the cpa");
  });

  it('replaces UUIDs (machine ids) with a placeholder', () => {
    expect(normalizeQuestionText('Approve task 3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f?')).toBe(
      normalizeQuestionText('Approve task 7d6e5f4a-9b8c-4d7e-a6f5-e4d3c2b1a0f9?'),
    );
  });

  it('keeps amounts, dates and other numbers — those are different questions', () => {
    expect(normalizeQuestionText('Was the $1,200 charge a refund?')).not.toBe(normalizeQuestionText('Was the $900 charge a refund?'));
    expect(normalizeQuestionText('Reconcile 2026-09?')).not.toBe(normalizeQuestionText('Reconcile 2026-10?'));
  });
});

describe('groupOpenQuestions', () => {
  it('collapses repeated questions in one workspace into a single group with count and oldest/newest', () => {
    const items = [
      q('empera', 'What bank does Empera use?', '2026-10-01T10:00:00Z'),
      q('empera', 'what bank does Empera use', '2026-10-03T10:00:00Z'),
      q('empera', '  What  bank does Empera use? ', '2026-10-02T10:00:00Z'),
      q('empera', 'Who is the CPA?', '2026-10-02T12:00:00Z'),
    ];
    const groups = groupOpenQuestions(items);
    expect(groups).toHaveLength(2);
    const bank = groups[0]!;
    expect(bank.count).toBe(3);
    expect(bank.oldestAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(bank.newestAt.toISOString()).toBe('2026-10-03T10:00:00.000Z');
    expect(bank.question).toBe('what bank does Empera use'); // newest wording shown
    expect(bank.questions.map((m) => m.createdAt.toISOString())).toEqual([
      '2026-10-01T10:00:00.000Z',
      '2026-10-02T10:00:00.000Z',
      '2026-10-03T10:00:00.000Z',
    ]);
    expect(groups[1]!.count).toBe(1);
  });

  it('never groups across workspaces (tenant isolation), even with identical text', () => {
    const items = [
      q('empera', 'What is the sales tax rate?', '2026-10-01T10:00:00Z'),
      q('accuratebids', 'What is the sales tax rate?', '2026-10-01T11:00:00Z'),
      q('empera', 'what is the sales tax rate', '2026-10-02T10:00:00Z'),
    ];
    const groups = groupOpenQuestions(items);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(new Set(g.questions.map((m) => m.projectKey))).toEqual(new Set([g.projectKey]));
    }
    expect(groups.find((g) => g.projectKey === 'empera')!.count).toBe(2);
    expect(groups.find((g) => g.projectKey === 'accuratebids')!.count).toBe(1);
  });

  it('the counts shown always add up to the individual questions — nothing lost or duplicated', () => {
    const items: OpenOwnerQuestion[] = [];
    for (let i = 0; i < 25; i += 1) {
      items.push(q('empera', i % 3 === 0 ? 'Which account is payroll?' : `Categorize transaction #${i % 4}?`, `2026-10-0${1 + (i % 9)}T0${i % 10}:00:00Z`));
    }
    for (let i = 0; i < 7; i += 1) items.push(q('accuratebids', 'Bid margin target?', `2026-10-05T0${i}:00:00Z`));
    const groups = groupOpenQuestions(items);
    for (const g of groups) expect(g.count).toBe(g.questions.length);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(items.length);
    const ids = groups.flatMap((g) => g.questions.map((m) => m.questionId));
    expect(new Set(ids).size).toBe(items.length);
    expect(new Set(ids)).toEqual(new Set(items.map((m) => m.questionId)));
  });

  it('orders groups oldest-first and lists distinct askers', () => {
    const items = [
      q('empera', 'Later question', '2026-10-05T00:00:00Z'),
      q('empera', 'Earlier question', '2026-10-01T00:00:00Z', { askedBy: 'Bookkeeper' }),
      q('empera', 'earlier question', '2026-10-02T00:00:00Z', { askedBy: 'Office Manager' }),
      q('empera', 'Earlier question.', '2026-10-03T00:00:00Z', { askedBy: 'Bookkeeper' }),
      q('empera', 'Earlier question', '2026-10-04T00:00:00Z', { askedBy: null }),
    ];
    const groups = groupOpenQuestions(items);
    expect(groups.map((g) => g.count)).toEqual([4, 1]);
    expect(groups[0]!.askedBy).toEqual(['Bookkeeper', 'Office Manager']);
  });

  it('returns no groups for no questions', () => {
    expect(groupOpenQuestions([])).toEqual([]);
  });
});
