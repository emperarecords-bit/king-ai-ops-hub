import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/lib/errors';
import { buildAppJwt, InstallationTokenSource, type FetchLike } from '@/domain/github/app-auth';
import { LiveGitHubClient } from '@/domain/github/live-client';

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
});
