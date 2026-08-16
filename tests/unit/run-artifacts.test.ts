import { describe, expect, it } from 'vitest';
import { ARTIFACT_BLOCK_OPEN, extractRunArtifacts, MAX_ARTIFACTS_PER_RUN } from '@/orchestration/artifacts-block';
import { buildPrimarySystem } from '@/orchestration/prompts';

const block = (json: string) => `${ARTIFACT_BLOCK_OPEN}\n${json}\n\`\`\``;

describe('run artifact extraction (TB-4)', () => {
  it('extracts multiple artifact blocks from one reply', () => {
    const text = `Here is the brief.\n${block(JSON.stringify({ name: 'Episode 1 Art Brief', kind: 'markdown', content: '# Brief\nWarm palette.' }))}\nAnd the checklist.\n${block(JSON.stringify({ name: 'Render QC Checklist', kind: 'markdown', content: '- no flicker' }))}`;
    const out = extractRunArtifacts(text);
    expect(out.rejected).toEqual([]);
    expect(out.artifacts.map((a) => a.name)).toEqual(['Episode 1 Art Brief', 'Render QC Checklist']);
  });

  it('reports malformed blocks individually without repairing, and returns nothing when absent', () => {
    expect(extractRunArtifacts('plain reply')).toEqual({ artifacts: [], rejected: [] });
    const out = extractRunArtifacts(`${block('not json')}\n${block(JSON.stringify({ name: 'Good', kind: 'text', content: 'ok' }))}\n${block(JSON.stringify({ name: 'Bad kind', kind: 'file', content: 'x' }))}`);
    expect(out.artifacts.map((a) => a.name)).toEqual(['Good']);
    expect(out.rejected).toHaveLength(2);
  });

  it('caps artifacts per run', () => {
    const many = Array.from({ length: 5 }, (_, i) => block(JSON.stringify({ name: `A${i}`, kind: 'text', content: 'x' }))).join('\n');
    const out = extractRunArtifacts(many);
    expect(out.artifacts).toHaveLength(MAX_ARTIFACTS_PER_RUN);
  });

  it('every primary system prompt carries the artifact contract', () => {
    const sys = buildPrimarySystem('You are the Art Director.');
    expect(sys).toContain(ARTIFACT_BLOCK_OPEN);
    expect(sys).toContain('save it as an artifact');
  });
});
