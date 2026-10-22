import { describe, expect, it } from 'vitest';
import { PREPARE_UPDATE_CARD } from '@/domain/opschat/stale-wording';
import { describeTaskState } from '@/domain/opschat/task-state';
import { conversationContextSection } from '@/domain/opschat/conversation-continuity';
import { createOpsChatToolset } from '@/domain/opschat/tools';

/**
 * Regression (Hub prod 2026-10-22, first v92 turn): told to "offer ONE update card", Ops Chat replied "Want me to
 * dispatch one fresh run…? Nothing runs until you confirm." instead of preparing the card — the ask-and-wait loop
 * P5c-2 exists to remove. Every surface the model reads about stale work must say: PREPARE the update card now (it
 * starts nothing — the card is the owner's confirmation), and never redo stale work with a plain dispatch / re-run.
 */

describe('stale-work wording — prepare, never ask; never a plain dispatch / re-run', () => {
  it('the shared phrase says both rules and never says "offer"', () => {
    expect(PREPARE_UPDATE_CARD).toContain('PREPARE ONE update card now with propose_update_task');
    expect(PREPARE_UPDATE_CARD).toContain("preparing it starts nothing (the card is the owner's confirmation)");
    expect(PREPARE_UPDATE_CARD).toContain('do not ask permission to prepare it');
    expect(PREPARE_UPDATE_CARD).toContain('never redo stale work with propose_dispatch_task or propose_rerun_task');
    expect(PREPARE_UPDATE_CARD).not.toMatch(/\boffer\b/i);
  });

  it('task state of stale work carries it verbatim', () => {
    const s = describeTaskState({
      taskId: 't',
      title: 'Server Cabinet Cooling',
      status: 'completed',
      job: null,
      run: { id: 'r', status: 'completed', reviewOutcome: 'required_unmet', startedAt: new Date('2026-10-19T11:41:35Z'), finishedAt: new Date('2026-10-19T11:41:43Z'), resultChars: 5255 },
      pendingApprovals: [],
      decisions: [{ kind: 'question_answered', id: 'q', at: new Date('2026-10-20T12:51:21Z'), summary: 'Lead-Lag?' }],
    });
    expect(s.ownerFacing).toContain(PREPARE_UPDATE_CARD);
    expect(s.ownerFacing).not.toMatch(/\boffer\b/i);
  });

  it('the conversation section carries it for a stale active job', () => {
    const section = conversationContextSection(
      [
        {
          proposalId: 'p',
          kind: 'dispatch_task',
          label: 'dispatch "x"',
          projectKey: 'hvac',
          view: { taskId: 't', runId: 'r', state: 'draft', finishedAt: '2026-10-19T11:41:43.000Z', activeAt: '2026-10-19T11:41:43.000Z', text: 'Finished.' },
          stale: { decisions: 4 },
        },
      ],
      null,
    );
    expect(section).toContain(PREPARE_UPDATE_CARD);
  });

  it('propose_update_task\'s description: call it DIRECTLY; the ONLY way to redo stale work', () => {
    const tool = createOpsChatToolset({ userId: 'u', projects: [], orgRoles: new Map() }).tools.find((t) => t.name === 'propose_update_task')!;
    expect(tool.description).toContain('Call it DIRECTLY as soon as work is stale — do not first ask the owner whether to prepare it');
    expect(tool.description).toContain('never propose_rerun_task');
    expect(tool.description).toContain('never propose_dispatch_task with hand-written instructions');
  });
});
