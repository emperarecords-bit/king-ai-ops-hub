import { describe, expect, it } from 'vitest';
import { includesEmailDesk, runContextScope } from '@/domain/tasks/run-context-scope';
import { formatSightBriefing } from '@/domain/integrations/accuratebids-sight';
import { approvalSubjectKey, decideSubject, type SubjectHistoryRow } from '@/domain/approvals/subject';

/**
 * Pure halves of the run-context isolation + persistent-rejection fix (server-cooling evidence, Hub prod
 * 2026-10-19). The DB-backed end-to-end proof is tests/integration/run-context-isolation.test.ts.
 */

describe('runContextScope', () => {
  it('ad-hoc owner task (no schedule, no objective) is focused — no Email Desk', () => {
    expect(runContextScope({ scheduleId: null, objectiveId: null })).toBe('focused');
    expect(includesEmailDesk('focused')).toBe(false);
  });
  it('standing and objective work keep their queues', () => {
    expect(runContextScope({ scheduleId: 's', objectiveId: null })).toBe('standing');
    expect(runContextScope({ scheduleId: 's', objectiveId: 'o' })).toBe('standing');
    expect(runContextScope({ scheduleId: null, objectiveId: 'o' })).toBe('objective');
    expect(includesEmailDesk('standing')).toBe(true);
    expect(includesEmailDesk('objective')).toBe(true);
  });
});

describe('formatSightBriefing — Email Desk only for runs that own it', () => {
  const data = {
    as_of: '2026-10-19T14:50:00Z',
    quotes: { total: 1, by_status: { sent: 1 }, won_total: 0, recent: [] },
    invoices: { total: 0, open_count: 0, open_balance: 0, recent: [] },
    support: {
      open: [{ id: 'e4c08c7c-1111', created_at: '2026-09-27', name: 'ONEAL', email: 'oneal@example.com', topic: 'billing', message: 'Cannot access my account after renewal' }],
    },
  };

  it('a focused (HVAC) run gets only a count and a do-not-act line — no id, name, email, message, or reply instruction', () => {
    const t = formatSightBriefing(data, { includeEmailDesk: false });
    expect(t).toMatch(/1 unanswered support inquiries exist/);
    expect(t).toMatch(/NOT by this task — do not draft, propose, or send replies/);
    for (const leak of ['ONEAL', 'e4c08c7c', 'oneal@example.com', 'Cannot access', 'propose it as an accuratebids_reply']) {
      expect(t).not.toContain(leak);
    }
  });

  it('default (standing Email Desk work) is unchanged', () => {
    const t = formatSightBriefing(data);
    expect(t).toContain('EMAIL DESK - 1 unanswered support inquiries');
    expect(t).toContain('[id e4c08c7c-1111]');
  });
});

describe('approval subjects — the ONEAL history (request e4c08c7c), 11 approvals 2026-09-28 → 10-19', () => {
  const REQ = 'e4c08c7c-1111';
  const key = approvalSubjectKey({ kind: 'accuratebids_reply', request_id: REQ, reply_text: 'x' })!;
  const d = (iso: string) => new Date(iso);
  // Exact production shape: 7 expired, effcc035 rejected 10-18 22:57, then 6fb29e0a pending (10-19 09:00).
  const history: SubjectHistoryRow[] = [
    { id: 'effcc035', status: 'rejected', decidedAt: d('2026-10-18T22:57:18Z') },
    { id: '6fb29e0a', status: 'pending', decidedAt: null },
  ];
  const hvac = { scheduleId: null, createdAt: d('2026-10-19T14:50:03Z'), input: 'Customer job: two Bard HR58AP units … size the ducts.' };

  it('the subject is the support request, whatever the action type or wording', () => {
    expect(key).toBe(`support_request:${REQ}`);
    expect(approvalSubjectKey({ request_id: REQ, reply_text: 'different words' })).toBe(key); // email_send shape
    expect(approvalSubjectKey({ path: 'punch_list.md' })).toBeNull();
    expect(approvalSubjectKey(null)).toBeNull();
  });

  it('edb61199 (HVAC run, 10-19 14:50) would be suppressed — a decision on this subject is already pending', () => {
    expect(decideSubject(key, history, hvac)).toEqual({ allow: false, reason: 'pending_same_subject', approvalId: '6fb29e0a' });
  });

  it('with nothing pending, the owner rejection still blocks standing re-proposals (566d09bc, 10-19 21:00)', () => {
    const standing = { scheduleId: 'sched', createdAt: d('2026-10-19T21:00:00Z'), input: `Work the Email Desk; request ${REQ} is open.` };
    expect(decideSubject(key, [history[0]!], standing)).toEqual({ allow: false, reason: 'rejected_subject', approvalId: 'effcc035' });
  });

  it('an owner-created task after the rejection that names the request may reconsider it', () => {
    const ask = { scheduleId: null, createdAt: d('2026-10-20T08:00:00Z'), input: `Reconsider support request ${REQ}.` };
    expect(decideSubject(key, [history[0]!], ask)).toEqual({ allow: true, reason: 'owner_reconsider' });
  });

  it('an owner task created BEFORE the rejection does not count as a reconsider request', () => {
    const early = { scheduleId: null, createdAt: d('2026-10-18T20:00:00Z'), input: `Reply to ${REQ}.` };
    expect(decideSubject(key, [history[0]!], early).allow).toBe(false);
  });

  it('a subject with only expired history is free to propose', () => {
    expect(decideSubject(key, [], hvac)).toEqual({ allow: true });
  });
});
