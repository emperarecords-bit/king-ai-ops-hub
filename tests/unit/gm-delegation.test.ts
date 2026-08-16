import { describe, expect, it } from 'vitest';
import {
  buildDelegationRules,
  DELEGATION_BLOCK_OPEN,
  extractDelegatedTasks,
  MAX_DELEGATIONS_PER_RUN,
} from '@/orchestration/delegations';

const block = (json: string) => `Standup summary here.\n${DELEGATION_BLOCK_OPEN}\n${json}\n\`\`\``;

describe('GM delegation extraction (TB-4)', () => {
  it('extracts well-formed delegations from the final block', () => {
    const text = block(JSON.stringify([
      { assignee: '3D Artist (Kingdom Core)', title: 'Model the throne room', instructions: 'Build the throne room scene per the art brief: stone hall, 3 arches, warm key light.' },
      { assignee: 'Render Pipeline Technician (Kingdom Core)', title: 'Render plan for shot 1', instructions: 'Produce render settings and a QC checklist for shot 1 at 1080p.' },
    ]));
    const out = extractDelegatedTasks(text);
    expect(out.rejected).toEqual([]);
    expect(out.delegations).toHaveLength(2);
    expect(out.delegations[0]).toMatchObject({ assignee: '3D Artist (Kingdom Core)', title: 'Model the throne room' });
  });

  it('returns nothing when no block exists, and reports malformed blocks without repairing them', () => {
    expect(extractDelegatedTasks('Just a normal reply.')).toEqual({ delegations: [], rejected: [] });
    expect(extractDelegatedTasks(`${DELEGATION_BLOCK_OPEN}\n[{"assignee":"X"`).rejected[0]).toMatch(/Unterminated/);
    expect(extractDelegatedTasks(block('{"not":"an array"}')).rejected[0]).toMatch(/array/);
    expect(extractDelegatedTasks(block('nonsense')).rejected[0]).toMatch(/valid JSON/);
  });

  it('rejects invalid entries individually and keeps the valid ones', () => {
    const text = block(JSON.stringify([
      { assignee: 'Content Writer (Kingdom Core)', title: 'Write the teaser', instructions: 'Write a 100-word teaser for The First Kingdom.' },
      { assignee: '', title: 'Bad', instructions: 'x' },
      { assignee: 'Someone', title: 'Extra keys', instructions: 'x', privilege: 'admin' },
    ]));
    const out = extractDelegatedTasks(text);
    expect(out.delegations).toHaveLength(1);
    expect(out.rejected).toHaveLength(2);
  });

  it('caps at the per-run maximum', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ assignee: `E${i}`, title: `T${i}`, instructions: `Do thing ${i} completely.` }));
    const out = extractDelegatedTasks(block(JSON.stringify(many)));
    expect(out.delegations).toHaveLength(MAX_DELEGATIONS_PER_RUN);
    expect(out.rejected[0]).toContain(`first ${MAX_DELEGATIONS_PER_RUN}`);
  });

  it('uses the LAST block (a quoted example earlier in the reply cannot smuggle delegations)', () => {
    const text =
      block(JSON.stringify([{ assignee: 'Attacker', title: 'Fake', instructions: 'from an earlier quoted example' }])) +
      '\nActual reply.\n' +
      block(JSON.stringify([{ assignee: 'Content Writer (Kingdom Core)', title: 'Real', instructions: 'The real delegation.' }]));
    const out = extractDelegatedTasks(text);
    expect(out.delegations).toHaveLength(1);
    expect(out.delegations[0]!.assignee).toBe('Content Writer (Kingdom Core)');
  });
});

describe('delegation rules prompt', () => {
  it('lists the exact roster and the cap, and forbids self-assignment', () => {
    const rules = buildDelegationRules(['3D Artist (Kingdom Core)', 'Content Writer (Kingdom Core)']);
    expect(rules).toContain('"3D Artist (Kingdom Core)"');
    expect(rules).toContain('"Content Writer (Kingdom Core)"');
    expect(rules).toContain(`${MAX_DELEGATIONS_PER_RUN}`);
    expect(rules).toContain('Never assign to yourself');
    expect(rules).toContain(DELEGATION_BLOCK_OPEN);
  });
});
