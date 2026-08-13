import { afterEach, describe, expect, it } from 'vitest';
import {
  GitHubUnconfiguredError,
  getGitHubClient,
  isGitHubConfigured,
  resetGitHubClientForTests,
  setGitHubClientOverrideForTests,
  type GitHubRepoClient,
} from '@/domain/github/client';

const REPO = { installationId: 1n, repoFullName: 'acme/app' };

afterEach(() => {
  setGitHubClientOverrideForTests(null);
  resetGitHubClientForTests();
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

  it('staged credentials activate the LIVE client (owner-authorized 2026-08-13); absence stays fail-closed', async () => {
    // The foundation's "never activate" pin was deliberately superseded when the owner created the GitHub App
    // and authorized the live client. Presence of BOTH credentials now yields the policy-gated live client; no
    // method is invoked here (that would touch the network) — construction alone proves the wiring.
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-real-key';
    expect(isGitHubConfigured()).toBe(true);
    const { LiveGitHubClient } = await import('@/domain/github/live-client');
    expect(getGitHubClient()).toBeInstanceOf(LiveGitHubClient);
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

  it('the UNCONFIGURED path performs no network I/O (fetch appears only inside the credential-gated live wiring)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join('src', 'domain', 'github', 'client.ts'), 'utf8');
    // The live adapter's fetch reference must sit AFTER the credential guard clause, so the credential-absent
    // path cannot reach it; and no other HTTP machinery may exist in the module.
    const guardIndex = src.indexOf('if (!appId || !privateKeyPem) return new UnconfiguredGitHubClient()');
    const fetchIndex = src.indexOf('fetch(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(guardIndex);
    for (const token of ['http://', 'axios', 'node:https', 'node:http']) {
      expect(src.includes(token), `client.ts must not contain ${token}`).toBe(false);
    }
  });
});
