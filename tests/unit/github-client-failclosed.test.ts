import { afterEach, describe, expect, it } from 'vitest';
import {
  GitHubUnconfiguredError,
  getGitHubClient,
  isGitHubConfigured,
  setGitHubClientOverrideForTests,
  type GitHubRepoClient,
} from '@/domain/github/client';

const REPO = { installationId: 1n, repoFullName: 'acme/app' };

afterEach(() => {
  setGitHubClientOverrideForTests(null);
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

describe('github client — fail closed without owner-gated credentials', () => {
  it('every operation rejects with GitHubUnconfiguredError when credentials are absent', async () => {
    const client = getGitHubClient();
    await expect(client.listTree(REPO, 'main')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
    await expect(client.readBlob(REPO, 'main', 'README.md')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
    await expect(client.createBranch(REPO, 'main', 'feature/x')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
    await expect(client.commitToBranch(REPO, 'feature/x', [], 'msg')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
    await expect(client.openPullRequest(REPO, { fromBranch: 'feature/x', intoBranch: 'main', title: 't', body: 'b' })).rejects.toBeInstanceOf(GitHubUnconfiguredError);
  });

  it('staging credentials does NOT silently activate live access in this phase (still fail-closed)', async () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-real-key';
    expect(isGitHubConfigured()).toBe(true);
    // Foundation contract: even configured, no live client exists until the owner-approved follow-up lands.
    await expect(getGitHubClient().listTree(REPO, 'main')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
  });

  it('isGitHubConfigured requires BOTH credentials', () => {
    expect(isGitHubConfigured()).toBe(false);
    process.env.GITHUB_APP_ID = '12345';
    expect(isGitHubConfigured()).toBe(false);
    process.env.GITHUB_APP_PRIVATE_KEY = 'k';
    expect(isGitHubConfigured()).toBe(true);
  });

  it('a test override is honored and clearable (the only non-refusing path, test-scoped)', async () => {
    const fake: GitHubRepoClient = {
      listTree: async () => [{ path: 'README.md', type: 'blob', size: 10 }],
      readBlob: async () => 'hello',
      createBranch: async () => undefined,
      commitToBranch: async () => undefined,
      openPullRequest: async () => ({ prNumber: 7 }),
    };
    setGitHubClientOverrideForTests(fake);
    expect(await getGitHubClient().readBlob(REPO, 'main', 'README.md')).toBe('hello');
    setGitHubClientOverrideForTests(null);
    await expect(getGitHubClient().readBlob(REPO, 'main', 'README.md')).rejects.toBeInstanceOf(GitHubUnconfiguredError);
  });

  it('the module performs no network I/O: no fetch/http reference exists in its source', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join('src', 'domain', 'github', 'client.ts'), 'utf8');
    for (const token of ['fetch(', 'http://', 'https://api.', 'axios', 'node:https', 'node:http']) {
      expect(src.includes(token), `client.ts must not contain ${token}`).toBe(false);
    }
  });
});
