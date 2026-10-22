import { describe, expect, it } from 'vitest';
import {
  activeJob,
  anchorEntries,
  completionEntries,
  conversationContextSection,
  LEADING,
  type ContinuityCard,
} from '@/domain/opschat/conversation-continuity';
import { type LinkedRunState, type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { PREPARE_UPDATE_CARD } from '@/domain/opschat/stale-wording';
import { applyLiveRunUpdate, buildTranscript, needsRunPolling, type PersistedMessage, type TranscriptMsg } from '@/app/ops/ops-chat-transcript';

/**
 * P5c-3 — conversational continuity (pure halves): completion entries (one per finished linked run, placed by finish
 * time), the active job a short follow-up means, the per-turn "THIS CONVERSATION" prompt section, and the browser's
 * live-refresh merge. DB / route proofs: tests/integration/opschat-continuity-e2e.test.ts.
 */

const view = (state: LinkedRunState, over: Partial<LinkedRunView> = {}): LinkedRunView => ({
  taskId: 't1',
  runId: state === 'queued' ? null : 'r1',
  state,
  finishedAt: ['ready', 'draft', 'needs_approval', 'failed'].includes(state) ? '2026-10-20T10:42:00.000Z' : null,
  activeAt: '2026-10-20T10:42:00.000Z',
  text: `text ${state}`,
  ...over,
});
const card = (id: string, v: LinkedRunView | null, over: Partial<ContinuityCard> = {}): ContinuityCard => ({
  proposalId: id,
  kind: 'dispatch_task',
  label: `dispatch "${id}"`,
  projectKey: 'hvac',
  view: v,
  ...over,
});

describe('completionEntries — exactly one per FINISHED linked run', () => {
  it('ready/draft/needs_approval/failed become entries with their label; queued/running/no_run/unlinked do not', () => {
    const out = completionEntries([
      card('a', view('ready', { finishedAt: '2026-10-20T10:00:00.000Z' })),
      card('b', view('draft', { finishedAt: '2026-10-20T09:00:00.000Z' })),
      card('c', view('needs_approval')),
      card('d', view('failed')),
      card('e', view('running')),
      card('f', view('queued')),
      card('g', view('no_run', { runId: null })),
      card('h', null),
    ]);
    expect(out.map((e) => [e.proposalId, e.resultLabel])).toEqual([
      ['b', 'UNREVIEWED DRAFT'],
      ['a', 'FINAL'],
      ['c', 'APPROVAL NEEDED'],
      ['d', 'FAILED'],
    ]);
    expect(out[0]).toMatchObject({ runId: 'r1', taskId: 't1', taskPath: '/p/hvac/tasks/t1', label: 'dispatch "b"' });
    expect(completionEntries([card('x', view('ready'), { projectKey: null })])[0]!.taskPath).toBeNull();
  });
});

describe('anchorEntries — placed at finish time, deterministically', () => {
  const msgs = [
    { id: 'm1', createdAt: new Date('2026-10-20T09:00:00Z') },
    { id: 'm2', createdAt: new Date('2026-10-20T10:00:00Z') },
    { id: 'm3', createdAt: new Date('2026-10-20T11:00:00Z') },
  ];
  it('after the last message created at or before the finish; before everything → LEADING', () => {
    const e = (id: string, at: string) => ({ proposalId: id, runId: 'r', taskId: 't', label: id, resultLabel: 'FINAL' as const, finishedAt: at, text: '', taskPath: null });
    const m = anchorEntries(msgs, [e('early', '2026-10-20T08:00:00Z'), e('mid', '2026-10-20T10:30:00Z'), e('exact', '2026-10-20T10:00:00Z'), e('late', '2026-10-20T12:00:00Z')]);
    expect(m.get(LEADING)!.map((x) => x.proposalId)).toEqual(['early']);
    expect(m.get('m2')!.map((x) => x.proposalId)).toEqual(['mid', 'exact']);
    expect(m.get('m3')!.map((x) => x.proposalId)).toEqual(['late']);
  });
});

describe('activeJob — what "any response?" means', () => {
  it('the most recently active job; one job still in flight wins over a newer finished one', () => {
    const older = card('older', view('ready', { activeAt: '2026-10-20T09:00:00.000Z' }));
    const newer = card('newer', view('draft', { activeAt: '2026-10-20T11:00:00.000Z' }));
    expect(activeJob([older, newer]).active?.proposalId).toBe('newer');
    const running = card('run', view('running', { activeAt: '2026-10-20T08:00:00.000Z' }));
    expect(activeJob([older, newer, running]).active?.proposalId).toBe('run');
  });
  it('two or more jobs still in flight is GENUINE ambiguity — no active job', () => {
    const r = activeJob([card('a', view('running')), card('b', view('queued'))]);
    expect(r.active).toBeNull();
    expect(r.ambiguous.map((c) => c.proposalId)).toEqual(['a', 'b']);
  });
  it('no linked job → nothing', () => {
    expect(activeJob([card('x', null)])).toEqual({ active: null, ambiguous: [] });
  });
});

describe('conversationContextSection — per-turn server record', () => {
  it('ACTIVE JOB with its stale state, finished-since entries, and the follow-up rule', () => {
    const s = conversationContextSection(
      [card('upd', view('draft', { finishedAt: '2026-10-20T12:00:00.000Z', activeAt: '2026-10-20T12:00:00.000Z' }), { stale: { decisions: 2 } }), card('old', view('ready', { finishedAt: '2026-10-19T14:50:11.000Z', activeAt: '2026-10-19T14:50:11.000Z' }))],
      new Date('2026-10-20T11:00:00Z'),
    );
    expect(s).toContain('=== THIS CONVERSATION');
    expect(s).toContain('ACTIVE JOB: dispatch "upd" — task t1 in workspace hvac (card upd): UNREVIEWED DRAFT. text draft STALE: its result PREDATES 2 owner decision(s) — ' + PREPARE_UPDATE_CARD);
    expect(s).toContain('Other jobs started here:\n- dispatch "old"');
    expect(s).toContain("Finished since the owner's previous message (tell the owner — they have not been told in this chat):\n- dispatch \"upd\" (task t1): UNREVIEWED DRAFT — text draft");
    expect(s).not.toMatch(/- dispatch "old" \(task t1\): FINAL/); // finished before the previous owner message
    expect(s).toMatch(/RULE: a short follow-up that names no task \("any response\?", "still waiting".*"server cooling\?"\) means the ACTIVE JOB above/);
  });
  it('superseded active job points at the update task; ambiguity tells Ops Chat to ask; no jobs → empty', () => {
    expect(conversationContextSection([card('a', view('ready'), { supersededBy: { taskId: 't2', title: 'Duct — updated with your answers' } })], null)).toContain(
      'SUPERSEDED by update task "Duct — updated with your answers" (t2) — report on that one.',
    );
    expect(conversationContextSection([card('a', view('running')), card('b', view('queued'))], null)).toContain('AMBIGUOUS: 2 jobs from this conversation are still in progress');
    expect(conversationContextSection([card('a', null)], null)).toBe('');
  });
});

describe('transcript — completion rows, live merge, polling', () => {
  const entry = (id: string, finishedAt = '2026-10-20T10:42:00.000Z') => ({ proposalId: id, runId: 'r1', taskId: 't1', label: `dispatch "${id}"`, resultLabel: 'FINAL' as const, finishedAt, text: 'Finished.', taskPath: '/p/hvac/tasks/t1' });
  const persisted: PersistedMessage[] = [
    { id: 'o1', role: 'user', status: 'complete', content: 'size the ducts', question: null, replyToMessageId: null, proposals: [], completionsAfter: [entry('between')] },
    {
      id: 'a1',
      role: 'assistant',
      status: 'complete',
      content: 'card below',
      question: null,
      replyToMessageId: 'o1',
      proposals: [{ id: 'card1', proposal: { kind: 'dispatch_task' }, state: 'done', result: null, error: null, linkedRun: { ...view('running'), runId: 'r1' } }],
      completionsAfter: [entry('after')],
    },
  ];

  it('completion rows sit where the server anchored them (leading, after the owner turn, after the reply)', () => {
    const t = buildTranscript(persisted, [entry('lead')]);
    expect(t.map((m) => m.id)).toEqual(['completion-lead', 'o1', 'completion-between', 'a1', 'completion-after']);
    expect(t[0]).toMatchObject({ role: 'server', completion: { proposalId: 'lead' } });
  });

  it('applyLiveRunUpdate patches the card and appends ONE completion row per finished run (idempotent)', () => {
    const t = buildTranscript(persisted);
    const finished = view('ready');
    const once = applyLiveRunUpdate(t, { card1: finished }, [entry('card1')]);
    expect(once.find((m) => m.id === 'a1')!.cards![0]!.linkedRun).toEqual(finished);
    expect(once.filter((m) => m.id === 'completion-card1')).toHaveLength(1);
    const twice = applyLiveRunUpdate(once, { card1: finished }, [entry('card1')]);
    expect(twice).toBe(once); // nothing changed → same array (no re-render)
  });

  it('needsRunPolling: only while a run-starting card is confirming, or confirmed with its run unknown / queued / running', () => {
    const t = buildTranscript(persisted);
    expect(needsRunPolling(t)).toBe(true); // running
    expect(needsRunPolling(applyLiveRunUpdate(t, { card1: view('ready') }, []))).toBe(false);
    const confirming: TranscriptMsg[] = [{ id: 'x', role: 'assistant', content: '', cards: [{ proposal: { kind: 'rerun_task' }, proposalId: 'p', state: 'confirming' }] }];
    expect(needsRunPolling(confirming)).toBe(true);
    const noLink: TranscriptMsg[] = [{ id: 'x', role: 'assistant', content: '', cards: [{ proposal: { kind: 'dispatch_task' }, proposalId: 'p', state: 'done' }] }];
    expect(needsRunPolling(noLink)).toBe(true);
    const other: TranscriptMsg[] = [{ id: 'x', role: 'assistant', content: '', cards: [{ proposal: { kind: 'decide_approval' }, proposalId: 'p', state: 'confirming' }] }];
    expect(needsRunPolling(other)).toBe(false);
  });
});
