import { describe, expect, it } from 'vitest';
import { evaluateFileWriteInspection, identitiesRemainStable, type InspectedPathKind } from '@/domain/execution/file-write-link-policy';

const component = (path: string, kind: InspectedPathKind, identity: string, parentIdentity: string, hardLinkCount = 1) =>
  ({ normalizedPath: path, kind, identity, parentIdentity, hardLinkCount });
const safe = () => ({
  components: [component('plans', 'directory', 'dir-plans', 'workspace')],
  target: component('plans/output.md', 'regular_file', 'file-output', 'dir-plans'),
});

describe('pure file-write link and identity policy', () => {
  it('accepts a complete regular-file chain and captures stable identities', () => {
    expect(evaluateFileWriteInspection(safe())).toEqual({ allowed: true, identityChain: ['dir-plans', 'file-output'] });
    expect(identitiesRemainStable(['dir-plans', 'file-output'], ['dir-plans', 'file-output'])).toBe(true);
  });
  it.each(['symlink', 'junction', 'reparse_point', 'special', 'unknown'] as const)('denies unsafe target kind %s', (kind) => {
    expect(evaluateFileWriteInspection({ ...safe(), target: component('plans/output.md', kind, 'target', 'dir-plans') }).allowed).toBe(false);
  });
  it.each(['symlink', 'junction', 'reparse_point', 'unknown'] as const)('denies unsafe parent kind %s', (kind) => {
    expect(evaluateFileWriteInspection({ ...safe(), components: [component('plans', kind, 'dir-plans', 'workspace')] }).allowed).toBe(false);
  });
  it('denies hard links, incomplete evidence, inconsistent parents, and component substitution', () => {
    expect(evaluateFileWriteInspection({ ...safe(), target: component('plans/output.md', 'regular_file', 'file-output', 'dir-plans', 2) }).allowed).toBe(false);
    expect(evaluateFileWriteInspection({ ...safe(), target: { ...safe().target, identity: null } }).allowed).toBe(false);
    expect(evaluateFileWriteInspection({ ...safe(), target: { ...safe().target, parentIdentity: 'swapped' } }).allowed).toBe(false);
    expect(identitiesRemainStable(['dir-plans', 'file-output'], ['dir-swapped', 'file-output'])).toBe(false);
    expect(identitiesRemainStable([], [])).toBe(false);
  });
});
