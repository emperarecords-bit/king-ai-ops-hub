import { describe, expect, it } from 'vitest';
import { assessGitWrite } from '@/domain/github/write-policy';

const LINKED = { linkedRepo: 'acme/app', defaultBranch: 'main' };

function assess(overrides: Partial<Parameters<typeof assessGitWrite>[0]>) {
  return assessGitWrite({
    actionType: 'git_commit',
    targetRepo: 'acme/app',
    targetBranch: 'feature/x',
    ...LINKED,
    ...overrides,
  });
}

describe('github write policy — branch + PR only, never a default-branch write', () => {
  it('allows a commit / push / PR-source on a work branch of the linked repo', () => {
    for (const actionType of ['git_commit', 'git_push', 'git_pr']) {
      const v = assess({ actionType });
      expect(v.allowed, `${actionType} to a work branch`).toBe(true);
      expect(v.reason).toContain('pull request'); // the allow itself restates that merging needs a PR
    }
  });

  it('DENIES any write to the default branch, in both spellings', () => {
    for (const targetBranch of ['main', 'refs/heads/main']) {
      const v = assess({ actionType: 'git_push', targetBranch });
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/default branch|never permitted/);
    }
  });

  it('DENIES main/master even when the recorded default branch is something else (stale/tampered link belt)', () => {
    for (const targetBranch of ['main', 'master']) {
      const v = assess({ targetBranch, defaultBranch: 'develop' });
      expect(v.allowed).toBe(false);
    }
  });

  it('DENIES a repository other than the linked one', () => {
    const v = assess({ targetRepo: 'acme/other' });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('linked repository');
  });

  it('DENIES non-git actions outright (file_write, deployment, unknown)', () => {
    for (const actionType of ['file_write', 'deployment', 'db_mutation', 'totally_made_up']) {
      expect(assess({ actionType }).allowed).toBe(false);
    }
  });

  it('DENIES malformed targets fail-closed: missing/empty/HEAD/invalid branch names, non-string repo', () => {
    expect(assess({ targetBranch: undefined as unknown as string }).allowed).toBe(false);
    expect(assess({ targetBranch: '' }).allowed).toBe(false);
    expect(assess({ targetBranch: 'HEAD' }).allowed).toBe(false);
    expect(assess({ targetBranch: 'refs/heads/HEAD' }).allowed).toBe(false);
    expect(assess({ targetBranch: 'bad..name' }).allowed).toBe(false);
    expect(assess({ targetBranch: 'trailing/' }).allowed).toBe(false);
    expect(assess({ targetBranch: 'x.lock' }).allowed).toBe(false);
    expect(assess({ targetBranch: '-leading-dash' }).allowed).toBe(false);
    expect(assess({ targetRepo: 42 as unknown as string }).allowed).toBe(false);
    expect(assess({ targetRepo: '' }).allowed).toBe(false);
  });

  it('is pure and deterministic', () => {
    const a = assess({});
    expect(assess({})).toEqual(a);
  });
});
