import { describe, expect, it } from 'vitest';
import { FakeProvider } from '@tests/support/fake-provider';
import { executeRun, type EngineAgent, type RunSink } from '@/orchestration/engine';
import { AUTHORITY, type ContextItemForPrompt } from '@/orchestration/prompts';

/**
 * Authority contract, engine + prompts together (O-16). Drives a real run with
 * a fake provider that records the request, and asserts the assembled prompt
 * carries the contract and the authority-labeled context in the right order.
 * The MODEL's conflict-surfacing behavior is checked in the live acceptance;
 * this proves the inputs it needs actually reach it.
 */

function agent(provider: FakeProvider): EngineAgent {
  return {
    agentId: 'a1',
    provider,
    model: 'fake-model',
    systemPrompt: 'You are the primary agent.',
    temperature: 0.5,
    maxOutputTokens: 1024,
  };
}

const noopSink: RunSink = {
  onStep: async () => {},
  onMalformedOutput: async () => {},
};

describe('authority contract reaches the model', () => {
  it('the conflict scenario: doc says complete, Hub says criterion unmet', async () => {
    const primary = new FakeProvider('openai').reply('done');
    // Level 3 document claims completion; Level 1 Hub state contradicts it.
    const contextItems: ContextItemForPrompt[] = [
      {
        title: 'Project state (Hub records)',
        content:
          'Objective "Finish Season 1" — active — 0/1 success criteria met. Criterion "Dialogue finalized" is UNMET.',
        authority: AUTHORITY.HUB_STATE,
        kind: 'Current Hub operational state',
        timestamp: '2026-07-24 12:00 UTC',
      },
      {
        title: 'Production_Status.md',
        content: 'Dialogue: COMPLETE for all episodes.',
        authority: AUTHORITY.PROJECT_DOCUMENT,
        kind: 'Linked project document (production status)',
      },
    ];

    await executeRun(
      {
        taskInput: 'Is dialogue finished?',
        contextItems,
        objective: null,
        primary: agent(primary),
        reviewer: null,
        perCallTimeoutMs: 1000,
        runDeadline: Date.now() + 10_000,
      },
      noopSink,
    );

    const req = primary.requests[0]!;

    // The contract is in the system prompt.
    expect(req.system).toMatch(/LEVEL 1 — Current Hub operational state/i);
    expect(req.system).toMatch(/Hub state is the current status/i);

    // Both conflicting facts reached the model, each under its authority header.
    const userTurn = req.turns.map((t) => t.content).join('\n');
    expect(userTurn).toContain('LEVEL 1 — CURRENT HUB OPERATIONAL STATE');
    expect(userTurn).toContain('Criterion "Dialogue finalized" is UNMET');
    expect(userTurn).toContain('LEVEL 3 — LINKED PROJECT DOCUMENTS');
    expect(userTurn).toContain('Dialogue: COMPLETE for all episodes');

    // Authority order: the Hub state is presented above the document.
    expect(userTurn.indexOf('LEVEL 1')).toBeLessThan(userTurn.indexOf('LEVEL 3'));
  });

  it('Hub state present ⇒ the contract tells the model not to plead missing access', async () => {
    const primary = new FakeProvider('openai').reply('ok');
    await executeRun(
      {
        taskInput: 'status?',
        contextItems: [
          {
            title: 'Project state (Hub records)',
            content: 'Objective active; 2 tasks in progress.',
            authority: AUTHORITY.HUB_STATE,
            kind: 'Current Hub operational state',
          },
        ],
        objective: null,
        primary: agent(primary),
        reviewer: null,
        perCallTimeoutMs: 1000,
        runDeadline: Date.now() + 10_000,
      },
      noopSink,
    );
    expect(primary.requests[0]!.system).toMatch(/do not say you lack project access/i);
  });
});
