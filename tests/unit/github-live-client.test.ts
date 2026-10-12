import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/lib/errors';
import { buildAppJwt, InstallationTokenSource, type FetchLike } from '@/domain/github/app-auth';
import { LiveGitHubClient, GitHubApiError } from '@/domain/github/live-client';

/**
 * Live-client tests — ZERO network: `fetchImpl` is a scripted recorder. The load-bearing assertions are the
 * policy ones: a default-branch write is refused BEFORE any mutating request leaves the client.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const REPO = { installationId: 153529449n, repoFullName: 'emperarecords-bit/king-ai-ops-hub' };

interface Recorded {
  method: string;
  url: string;
  body?: string;
}

/** Scripted fetch: routes by method+path substring; records every call in order. */
function fakeFetch(routes: Array<{ match: (m: string, u: string) => boolean; status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const route = routes.find((r) => r.match(init.method, url));
    if (!route) throw new Error(`unrouted request: ${init.method} ${url}`);
    return { status: route.status, json: async () => route.body };
  };
  return { impl, calls };
}

const tokenRoute = {
  match: (m: string, u: string) => m === 'POST' && u.includes('/app/installations/153529449/access_tokens'),
  status: 201,
  body: { token: 'itok-1', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
};
const repoInfoRoute = (defaultBranch: string) => ({
  match: (m: string, u: string) => m === 'GET' && u.endsWith('/repos/emperarecords-bit/king-ai-ops-hub'),
  status: 200,
  body: { default_branch: defaultBranch },
});

function client(impl: FetchLike) {
  return new LiveGitHubClient({ appId: '4585078', privateKeyPem: PRIVATE_PEM, fetchImpl: impl, apiBase: 'https://api.github.com' });
}

describe('app JWT', () => {
  it('is RS256, verifiable with the public key, issued by the App ID, and under the 10-minute cap', () => {
    const nowSeconds = 1_800_000_000;
    const jwt = buildAppJwt('4585078', PRIVATE_PEM, nowSeconds);
    const [h, p, s] = jwt.split('.');
    expect(s).toBeTruthy();
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('4585078');
    expect(payload.iat).toBeLessThan(nowSeconds); // backdated for clock skew
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).end().verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('installation token exchange + caching', () => {
  it('exchanges once and reuses the cached token until near expiry', async () => {
    const { impl, calls } = fakeFetch([tokenRoute]);
    const source = new InstallationTokenSource('4585078', PRIVATE_PEM, 153529449n, impl, 'https://api.github.com', () => Date.now());
    expect(await source.getToken()).toBe('itok-1');
    expect(await source.getToken()).toBe('itok-1');
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1); // cached
    expect(calls[0]!.method).toBe('POST');
  });
});

describe('live client reads', () => {
  it('listTree maps blobs/trees; readBlob decodes base64', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (m, u) => m === 'GET' && u.includes('/git/trees/'),
        status: 200,
        body: { tree: [{ path: 'README.md', type: 'blob', size: 12 }, { path: 'src', type: 'tree' }, { path: 'x', type: 'commit' }] },
      },
      {
        match: (m, u) => m === 'GET' && u.includes('/contents/README.md'),
        status: 200,
        body: { content: Buffer.from('hello repo').toString('base64'), encoding: 'base64' },
      },
    ]);
    const c = client(impl);
    const tree = await c.listTree(REPO, 'main');
    expect(tree).toEqual([
      { path: 'README.md', type: 'blob', size: 12 },
      { path: 'src', type: 'tree', size: null },
    ]);
    expect(await c.readBlob(REPO, 'main', 'README.md')).toBe('hello repo');
  });
});

describe('live client writes — policy gate BEFORE any mutating request', () => {
  it('createBranch to a work branch: policy consulted (repo info fetched), then ref resolved, then POST', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      repoInfoRoute('main'),
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/main'), status: 200, body: { object: { sha: 'abc123' } } },
      { match: (m, u) => m === 'POST' && u.endsWith('/git/refs'), status: 201, body: {} },
    ]);
    await client(impl).createBranch(REPO, 'main', 'feature/task-42');
    const mutating = calls.filter((c) => c.method !== 'GET' && !c.url.includes('/access_tokens'));
    expect(mutating).toHaveLength(1);
    expect(mutating[0]!.url).toContain('/git/refs');
    expect(JSON.parse(mutating[0]!.body!)).toEqual({ ref: 'refs/heads/feature/task-42', sha: 'abc123' });
  });

  it('createBranch NAMED like the default branch is refused with ZERO mutating requests', async () => {
    const { impl, calls } = fakeFetch([tokenRoute, repoInfoRoute('main')]);
    await expect(client(impl).createBranch(REPO, 'main', 'main')).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls.filter((c) => c.method !== 'GET' && !c.url.includes('/access_tokens'))).toHaveLength(0);
  });

  it('commitToBranch to the REAL default branch is refused even when the caller believes otherwise', async () => {
    // The repo's actual default is 'develop' — the caller targets it. Policy uses the LIVE value, not caller input.
    const { impl, calls } = fakeFetch([tokenRoute, repoInfoRoute('develop')]);
    await expect(
      client(impl).commitToBranch(REPO, 'develop', [{ path: 'a.txt', content: 'x' }], 'msg'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('commitToBranch to a work branch PUTs each file (create-new path tolerates 404 on existing-sha probe)', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      repoInfoRoute('main'),
      { match: (m, u) => m === 'GET' && u.includes('/contents/notes.md'), status: 404, body: {} },
      { match: (m, u) => m === 'PUT' && u.includes('/contents/notes.md'), status: 201, body: {} },
    ]);
    await client(impl).commitToBranch(REPO, 'feature/task-42', [{ path: 'notes.md', content: 'hi' }], 'add notes');
    const put = calls.find((c) => c.method === 'PUT')!;
    const body = JSON.parse(put.body!);
    expect(body.branch).toBe('feature/task-42');
    expect(Buffer.from(body.content, 'base64').toString()).toBe('hi');
    expect(body.sha).toBeUndefined();
  });

  it('openPullRequest INTO the default branch is allowed (the sanctioned route) and returns the PR number', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      repoInfoRoute('main'),
      { match: (m, u) => m === 'POST' && u.endsWith('/pulls'), status: 201, body: { number: 7 } },
    ]);
    const out = await client(impl).openPullRequest(REPO, { fromBranch: 'feature/task-42', intoBranch: 'main', title: 't', body: 'b' });
    expect(out.prNumber).toBe(7);
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/pulls'))!.body!)).toMatchObject({ head: 'feature/task-42', base: 'main' });
  });

  it('openPullRequest FROM the default branch is refused (source must be a work branch)', async () => {
    const { impl, calls } = fakeFetch([tokenRoute, repoInfoRoute('main')]);
    await expect(
      client(impl).openPullRequest(REPO, { fromBranch: 'main', intoBranch: 'main', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls.filter((c) => c.url.endsWith('/pulls'))).toHaveLength(0);
  });

  it('createRefAtSha to a work branch: policy consulted, then POSTs refs/heads/<branch> at the exact sha', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      repoInfoRoute('main'),
      { match: (m, u) => m === 'POST' && u.endsWith('/git/refs'), status: 201, body: {} },
    ]);
    await client(impl).createRefAtSha(REPO, 'hub/revert-abcdef', 'f'.repeat(40));
    const mutating = calls.filter((c) => c.method !== 'GET' && !c.url.includes('/access_tokens'));
    expect(mutating).toHaveLength(1);
    expect(mutating[0]!.url).toContain('/git/refs');
    expect(JSON.parse(mutating[0]!.body!)).toEqual({ ref: 'refs/heads/hub/revert-abcdef', sha: 'f'.repeat(40) });
  });

  it('createRefAtSha onto the REAL default branch is refused with ZERO mutating requests', async () => {
    const { impl, calls } = fakeFetch([tokenRoute, repoInfoRoute('develop')]);
    await expect(client(impl).createRefAtSha(REPO, 'develop', 'f'.repeat(40))).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toHaveLength(0);
  });
});

describe('live client Git Data API reads (revert support)', () => {
  it('getCommit resolves a ref to sha, first-line subject, tree sha, and parent shas', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (m, u) => m === 'GET' && u.includes('/commits/main'),
        status: 200,
        body: { sha: 'e'.repeat(40), commit: { message: 'Merge PR #1\n\nbody line', tree: { sha: 'tree-e' } }, parents: [{ sha: 'd'.repeat(40) }] },
      },
    ]);
    const c = await client(impl).getCommit(REPO, 'main');
    expect(c).toEqual({ sha: 'e'.repeat(40), subject: 'Merge PR #1', treeSha: 'tree-e', parents: ['d'.repeat(40)] });
  });

  it('getFlatTree carries mode/type/sha identity and surfaces the truncated flag', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      {
        match: (m, u) => m === 'GET' && u.includes('/git/trees/tree-e'),
        status: 200,
        body: { truncated: true, tree: [{ path: 'a', mode: '100755', type: 'blob', sha: 'A1' }, { path: 'd', mode: '040000', type: 'tree', sha: 'T' }] },
      },
    ]);
    const t = await client(impl).getFlatTree(REPO, 'tree-e');
    expect(t.truncated).toBe(true);
    expect(t.entries).toEqual([
      { path: 'a', mode: '100755', type: 'blob', sha: 'A1' },
      { path: 'd', mode: '040000', type: 'tree', sha: 'T' },
    ]);
  });

  it('branchHeadSha returns the head SHA via the Git Refs API when the branch exists', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/'), status: 200, body: { ref: 'refs/heads/feature/x', object: { sha: 'a'.repeat(40), type: 'commit' } } },
    ]);
    expect(await client(impl).branchHeadSha(REPO, 'feature/x')).toBe('a'.repeat(40));
    // The branch is segment-encoded (slash preserved as a path separator), NOT %2F.
    expect(calls.find((c) => c.url.includes('/git/ref/heads/'))!.url).toContain('/git/ref/heads/feature/x');
  });

  it('branchHeadSha returns null when the branch is absent (refs endpoint 404, NOT the commits-endpoint 422)', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/'), status: 404, body: { message: 'Not Found' } },
    ]);
    expect(await client(impl).branchHeadSha(REPO, 'hub/revert-abcdef')).toBeNull();
  });

  it('branchHeadSha throws (fail-closed read) on any non-404 provider error', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/'), status: 500, body: {} },
    ]);
    await expect(client(impl).branchHeadSha(REPO, 'main')).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('compareCommits returns the ahead/behind status (ancestry proof)', async () => {
    const { impl } = fakeFetch([
      tokenRoute,
      { match: (m, u) => m === 'GET' && u.includes('/compare/'), status: 200, body: { status: 'ahead', ahead_by: 3, behind_by: 0 } },
    ]);
    expect(await client(impl).compareCommits(REPO, 'd'.repeat(40), 'e'.repeat(40))).toEqual({ status: 'ahead', aheadBy: 3, behindBy: 0 });
  });

  it('createTree (object mint, no policy gate) posts base_tree + overrides and createCommit posts one parent', async () => {
    const { impl, calls } = fakeFetch([
      tokenRoute,
      { match: (m, u) => m === 'POST' && u.endsWith('/git/trees'), status: 201, body: { sha: 'tree-new' } },
      { match: (m, u) => m === 'POST' && u.endsWith('/git/commits'), status: 201, body: { sha: 'commit-new' } },
    ]);
    const c = client(impl);
    const tree = await c.createTree(REPO, 'tree-base', [{ path: 'fileA', mode: '100644', type: 'blob', sha: 'A1' }, { path: 'gone', mode: '100644', type: 'blob', sha: null }]);
    expect(tree.treeSha).toBe('tree-new');
    expect(JSON.parse(calls.find((x) => x.url.endsWith('/git/trees'))!.body!)).toEqual({
      base_tree: 'tree-base',
      tree: [{ path: 'fileA', mode: '100644', type: 'blob', sha: 'A1' }, { path: 'gone', mode: '100644', type: 'blob', sha: null }],
    });
    const commit = await c.createCommit(REPO, { message: 'Revert d: x', treeSha: 'tree-new', parentSha: 'e'.repeat(40) });
    expect(commit.commitSha).toBe('commit-new');
    expect(JSON.parse(calls.find((x) => x.url.endsWith('/git/commits'))!.body!)).toEqual({ message: 'Revert d: x', tree: 'tree-new', parents: ['e'.repeat(40)] });
  });
});
