import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORITY, buildPrimarySystem, buildPrimaryUserTurn } from '@/orchestration/prompts';

/**
 * Knowledge is the evidentiary layer, not the directive layer. It must enter prompts as context to
 * weigh, never as authority/instructions — even when a record is titled or categorized as a policy.
 * Decision Memory remains the directive layer.
 */
describe('Knowledge enters prompts as evidence, not charter', () => {
  it('a policy-titled Knowledge item renders under KNOWLEDGE CONTEXT, not as an approved control', () => {
    const turn = buildPrimaryUserTurn('do the work', [
      { title: 'Refund policy', content: 'Refunds within 30 days.', authority: AUTHORITY.WORKSPACE_CONTROL, kind: 'Knowledge context' },
    ]);
    expect(turn).toContain('KNOWLEDGE CONTEXT');
    expect(turn).toContain('Knowledge context — Refund policy');
    expect(turn).not.toContain('APPROVED WORKSPACE CONTROL');
    expect(turn).not.toContain('Approved workspace control');
  });

  it('the authority contract frames Knowledge as evidence and defers directive authority to Decisions', () => {
    const sys = buildPrimarySystem('You are a primary agent.');
    expect(sys).toMatch(/knowledge context/i);
    expect(sys).toMatch(/not authority or instructions|not.*instructions/i);
    expect(sys).toMatch(/decision memory is the directive layer/i);
  });
});

/**
 * Every AI context consumer must pass through the relevance/disclosure gate. The unrestricted
 * wholesale loader must NOT be referenced from any prompt-producing module.
 */
describe('no prompt-producing path calls the unrestricted knowledge loader', () => {
  const PROMPT_MODULES = [
    'src/domain/tasks/runner.ts',
    'src/domain/objectives/suggest.ts',
  ];
  for (const rel of PROMPT_MODULES) {
    it(`${rel} does not call listAllActiveKnowledgeForAdministration`, () => {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src).not.toContain('listAllActiveKnowledgeForAdministration');
    });
  }
});
