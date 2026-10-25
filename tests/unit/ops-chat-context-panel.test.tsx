import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { conversationPanel } from '@/app/ops/ops-chat-panel-model';
import { OpsChatContextPanel } from '@/app/ops/ops-chat-context-panel';
import { type TranscriptCard } from '@/app/ops/ops-chat-transcript';
import { type LinkedRunView } from '@/domain/opschat/linked-run-view';

// Owner request 2026-10-25: a right panel with what this conversation set in motion.
const run = (state: LinkedRunView['state'], over: Partial<LinkedRunView> = {}): LinkedRunView => ({
  taskId: 'task-1',
  runId: 'run-1',
  state,
  finishedAt: null,
  text: 'x',
  ...over,
});

const dispatch = (id: string, title: string, linkedRun?: LinkedRunView, state: TranscriptCard['state'] = 'done'): TranscriptCard => ({
  proposal: { kind: 'dispatch_task', projectKey: 'empera-air-conditioning-and-heating', title, agentName: 'Senior Engineer' },
  proposalId: id,
  state,
  ...(linkedRun ? { linkedRun } : {}),
});

const messages = [
  { id: 'm1', cards: [dispatch('p1', 'Server Cabinet Cooling — punch list', run('ready', { taskId: 't1', notFound: [] }))] },
  {
    id: 'm2',
    cards: [
      dispatch('p2', 'Duct sizing', run('draft', { taskId: 't2' })),
      { proposal: { kind: 'answer_question', questionId: 'q-1' }, proposalId: 'p3', state: 'done' } as TranscriptCard,
      { proposal: { kind: 'record_decision', title: 'Lead-lag', taskTitle: 'Cooling' }, proposalId: 'p4', state: 'pending' } as TranscriptCard,
    ],
  },
  { id: 'm3', cards: [dispatch('p5', 'Vendor quote', run('needs_approval', { taskId: 't5' })), dispatch('p6', 'Not confirmed yet', undefined, 'pending')] },
  { id: 'm4', cards: [{ proposal: { kind: 'rerun_task', projectKey: 'stressprobe', taskId: 't7', taskTitle: 'Stall analysis' }, proposalId: 'p7', state: 'done' } as TranscriptCard] },
];

describe('conversationPanel', () => {
  const p = conversationPanel(messages);

  it('jobs: confirmed dispatch/re-run cards, newest first, with live state and a task link', () => {
    expect(p.jobs.map((j) => [j.label, j.stateLabel, j.href])).toEqual([
      ['Stall analysis', 'Starting', '/p/stressprobe/tasks/t7'],
      ['Vendor quote', 'Needs your approval', '/p/empera-air-conditioning-and-heating/tasks/t5'],
      ['Duct sizing', 'Unreviewed draft', '/p/empera-air-conditioning-and-heating/tasks/t2'],
      ['Server Cabinet Cooling — punch list', 'Done', '/p/empera-air-conditioning-and-heating/tasks/t1'],
    ]);
  });

  it('results: only finished answers (reviewed or unreviewed draft)', () => {
    expect(p.results.map((j) => j.label)).toEqual(['Duct sizing', 'Server Cabinet Cooling — punch list']);
  });

  it('needs you: unconfirmed cards and jobs waiting for approval, linked to the card', () => {
    expect(p.needsYou.map((n) => [n.label, n.anchor])).toEqual([
      ['record decision "Lead-lag" on "Cooling"', '#card-p4'],
      ['Approve: Vendor quote', '#card-p5'],
      ['dispatch "Not confirmed yet" to Senior Engineer', '#card-p6'],
    ]);
  });

  it('decisions: confirmed decision-type cards only', () => {
    expect(p.decisions.map((d) => d.label)).toEqual(['answer question q-1']);
  });

  it('an empty conversation is empty everywhere', () => {
    expect(conversationPanel([{ id: 'opening' }])).toEqual({ jobs: [], results: [], needsYou: [], decisions: [] });
  });
});

describe('the right panel', () => {
  it('renders each section, the not-found note and the usage line', () => {
    const panel = conversationPanel([
      { id: 'm', cards: [dispatch('p1', 'Punch list', run('ready', { taskId: 't1', notFound: ['Vendor material list'] }))] },
    ]);
    const html = renderToStaticMarkup(<OpsChatContextPanel panel={panel} usage={{ turns: 3, webSearches: 1, costMicros: '412345' }} />);
    for (const s of ['This conversation', 'Needs you', 'Jobs', 'Results', 'Decisions recorded', 'Usage']) expect(html).toContain(s);
    expect(html).toContain('Done · 1 item not found');
    expect(html).toContain('href="/p/empera-air-conditioning-and-heating/tasks/t1"');
    expect(html).toContain('$0.41');
    expect(html).toContain('3 replies');
    expect(html).toContain('1 web search');
    expect(html).toContain('Not counted toward any workspace limit');
  });

  it('empty states read plainly', () => {
    const html = renderToStaticMarkup(<OpsChatContextPanel panel={conversationPanel([])} usage={null} />);
    expect(html).toContain('Nothing waiting on you here.');
    expect(html).toContain('No jobs started from this chat yet.');
    expect(html).toContain('No recorded replies yet.');
  });
});
