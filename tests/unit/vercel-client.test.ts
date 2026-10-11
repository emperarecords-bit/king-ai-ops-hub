import { afterEach, describe, expect, it } from 'vitest';
import {
  getVercelClient,
  isVercelConfigured,
  resetVercelClientForTests,
  setVercelClientOverrideForTests,
  VercelUnconfiguredError,
} from '@/domain/vercel/client';
import { LiveVercelClient, type VercelFetchLike } from '@/domain/vercel/live-client';

/**
 * Vercel client (Phase 2D, read-only). Without the owner-gated VERCEL_TOKEN every method fails closed. The live
 * client speaks the Vercel REST API over an injected fetch (no network), with a bearer token and status-only
 * errors, and maps a deployment's production/preview target + source commit SHA + state.
 */

const REF = { projectId: 'prj_abcd1234efgh5678', teamId: null };
const TEAM_REF = { projectId: 'prj_abcd1234efgh5678', teamId: 'team_zzzz1111' };

afterEach(() => {
  setVercelClientOverrideForTests(null);
  resetVercelClientForTests();
  delete process.env.VERCEL_TOKEN;
});

describe('getVercelClient — fail closed without the token', () => {
  it('isVercelConfigured reflects the token presence', () => {
    delete process.env.VERCEL_TOKEN;
    expect(isVercelConfigured()).toBe(false);
    process.env.VERCEL_TOKEN = 'vt_x';
    expect(isVercelConfigured()).toBe(true);
  });

  it('every method rejects with VercelUnconfiguredError when the token is absent, performing no I/O', async () => {
    delete process.env.VERCEL_TOKEN;
    const client = getVercelClient();
    await expect(client.getProject(REF)).rejects.toBeInstanceOf(VercelUnconfiguredError);
    await expect(client.listDeployments(REF)).rejects.toBeInstanceOf(VercelUnconfiguredError);
  });

  it('a test override is returned when set', () => {
    const fake = { getProject: async () => ({ id: 'x', name: '', framework: null, productionUrl: null }), listDeployments: async () => [] };
    setVercelClientOverrideForTests(fake);
    expect(getVercelClient()).toBe(fake);
  });
});

function recorder(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl: VercelFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const r = responses[i++] ?? { status: 200, body: {} };
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { fetchImpl, calls };
}

describe('LiveVercelClient — wire shape + mapping', () => {
  it('getProject GETs /v9/projects/{id} with a bearer and maps name/framework/productionUrl', async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { id: 'prj_abcd1234efgh5678', name: 'accuratebids', framework: 'nextjs', targets: { production: { alias: ['accuratebids.com'] } } } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    const info = await client.getProject(REF);
    expect(info).toMatchObject({ id: 'prj_abcd1234efgh5678', name: 'accuratebids', framework: 'nextjs', productionUrl: 'accuratebids.com' });
    expect(calls[0]!.url).toBe('https://api.vercel.com/v9/projects/prj_abcd1234efgh5678');
    expect(calls[0]!.headers.authorization).toBe('Bearer vt_test');
  });

  it('listDeployments GETs /v6/deployments with projectId+limit and maps target/state/sourceSha/branch', async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { deployments: [
      { uid: 'dpl_1', url: 'ab-prod.vercel.app', state: 'READY', target: 'production', createdAt: 1_700_000_000_000, inspectorUrl: 'https://vercel.com/x/dpl_1', meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'main' } },
      { uid: 'dpl_2', url: 'ab-prev.vercel.app', readyState: 'BUILDING', target: null, created: 1_700_000_100_000, meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'feature/x' } },
    ] } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    const out = await client.listDeployments(REF, { limit: 5 });
    expect(calls[0]!.url).toBe('https://api.vercel.com/v6/deployments?projectId=prj_abcd1234efgh5678&limit=5');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'dpl_1', state: 'READY', target: 'production', sourceSha: 'a'.repeat(40), branch: 'main' });
    expect(out[1]).toMatchObject({ id: 'dpl_2', state: 'BUILDING', target: 'preview', branch: 'feature/x' });
    expect(out[0]!.createdAt).toMatch(/^20/); // ISO string
  });

  it('appends teamId when the linked project is team-scoped', async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { id: 'prj_abcd1234efgh5678', name: 'x' } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    await client.getProject(TEAM_REF);
    expect(calls[0]!.url).toBe('https://api.vercel.com/v9/projects/prj_abcd1234efgh5678?teamId=team_zzzz1111');
  });

  it('a non-200 is a status-only VercelApiError (no body echoed)', async () => {
    const { fetchImpl } = recorder([{ status: 403, body: { error: { message: 'secret detail' } } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    let caught: unknown;
    try { await client.getProject(REF); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ name: 'VercelApiError', status: 403 });
    expect((caught as Error).message).not.toMatch(/secret detail/);
  });
});
