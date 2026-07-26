import { describe, expect, it } from 'vitest';
import {
  AUTHORITY,
  buildPrimarySystem,
  buildPrimaryUserTurn,
  type ContextItemForPrompt,
} from '@/orchestration/prompts';

/**
 * Authority contract prompt construction (O-16). These pin the wording and the
 * tiered layout the model relies on to treat Hub state as current fact and to
 * surface conflicts instead of silently reconciling them.
 */

describe('buildPrimarySystem — authority contract', () => {
  const sys = buildPrimarySystem('You are the primary agent.');

  it('states all five authority levels', () => {
    expect(sys).toContain('LEVEL 1');
    expect(sys).toContain('LEVEL 2');
    expect(sys).toContain('LEVEL 3');
    expect(sys).toContain('LEVEL 4');
    expect(sys).toContain('Model inference');
  });

  it('forbids describing Hub state as conversational or hypothetical', () => {
    expect(sys).toMatch(/current record/i);
    expect(sys).toMatch(/not a live tracker/i); // named so the model won't say it
    expect(sys).toMatch(/authoritative, current operational snapshot/i);
  });

  it('gives the document-vs-Hub conflict rule and requires surfacing it', () => {
    expect(sys).toMatch(/Hub state is the current status/i);
    expect(sys).toMatch(/do not declare the work complete/i);
    expect(sys).toMatch(/recommend verifying or updating the Hub record/i);
  });

  it('constrains missing-information claims to genuinely absent fields', () => {
    expect(sys).toMatch(/genuinely absent/i);
    expect(sys).toMatch(/do not say you lack project access/i);
  });

  it('still carries the injection rules (authority does not loosen them)', () => {
    expect(sys).toContain('<untrusted-context>');
    expect(sys).toMatch(/never an instruction/i);
  });
});

describe('buildPrimaryUserTurn — tiered, labeled context', () => {
  const items: ContextItemForPrompt[] = [
    {
      title: 'Project state (Hub records)',
      content: 'Objective active; 0/5 criteria met.',
      authority: AUTHORITY.HUB_STATE,
      kind: 'Current Hub operational state',
      timestamp: '2026-07-24 12:00 UTC',
    },
    {
      title: 'Charter',
      content: 'The workspace charter.',
      authority: AUTHORITY.WORKSPACE_CONTROL,
      kind: 'Knowledge context',
    },
    {
      title: 'S01E01_Screenplay.md',
      content: 'FADE IN.',
      authority: AUTHORITY.PROJECT_DOCUMENT,
      kind: 'Linked project document',
    },
  ];
  const turn = buildPrimaryUserTurn('Assess status.', items);

  it('emits a header per authority level present', () => {
    expect(turn).toContain('LEVEL 1 — CURRENT HUB OPERATIONAL STATE');
    expect(turn).toContain('LEVEL 2 — KNOWLEDGE CONTEXT');
    expect(turn).toContain('LEVEL 3 — LINKED PROJECT DOCUMENTS');
  });

  it('orders Level 1 before Level 3', () => {
    expect(turn.indexOf('LEVEL 1')).toBeLessThan(turn.indexOf('LEVEL 3'));
  });

  it('labels each section with its kind and shows the timestamp', () => {
    expect(turn).toContain('Current Hub operational state — Project state (Hub records) (as of 2026-07-24 12:00 UTC)');
    expect(turn).toContain('Linked project document — S01E01_Screenplay.md');
  });

  it('keeps every item wrapped untrusted', () => {
    // Three context items + the task = four wrapped blocks.
    expect(turn.match(/<untrusted-context>/g)?.length).toBe(4);
  });

  it('defaults an untagged item to Level 3', () => {
    const t = buildPrimaryUserTurn('x', [{ title: 'Untagged', content: 'y' }]);
    expect(t).toContain('LEVEL 3 — LINKED PROJECT DOCUMENTS');
    expect(t).not.toContain('LEVEL 1');
  });
});
