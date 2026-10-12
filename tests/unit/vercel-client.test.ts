import { afterEach, describe, expect, it } from 'vitest';
import {
  getVercelClient,
  getVercelMutationClient,
  isVercelConfigured,
  resetVercelClientForTests,
  setVercelClientOverrideForTests,
  setVercelMutationClientOverrideForTests,
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
  setVercelMutationClientOverrideForTests(null);
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

function mutationRecorder(responses: Array<{ status: number; body?: unknown; empty?: boolean }>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const fetchImpl: VercelFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const r = responses[i++] ?? { status: 200, body: {} };
    // `empty: true` models a 204/empty-body response: real `fetch().json()` throws "Unexpected end of JSON input".
    return { status: r.status, json: async () => { if (r.empty) throw new SyntaxError('Unexpected end of JSON input'); return r.body ?? {}; } };
  };
  return { fetchImpl, calls };
}

describe('getVercelMutationClient — fail closed + wire shape', () => {
  it('every write rejects with VercelUnconfiguredError when the token is absent', async () => {
    delete process.env.VERCEL_TOKEN;
    const c = getVercelMutationClient();
    await expect(c.promote(REF, 'dpl_x00000001')).rejects.toBeInstanceOf(VercelUnconfiguredError);
    await expect(c.rollback(REF, 'dpl_x00000001')).rejects.toBeInstanceOf(VercelUnconfiguredError);
    await expect(c.redeploy(REF, { name: 'x', sourceDeploymentId: 'dpl_x00000001' })).rejects.toBeInstanceOf(VercelUnconfiguredError);
  });

  it('promote POSTs /v10/projects/{id}/promote/{deploymentId}', async () => {
    const { fetchImpl, calls } = mutationRecorder([{ status: 201, body: {} }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    await client.promote({ projectId: 'prj_abcd1234efgh5678', teamId: 'team_z1' }, 'dpl_target00000001');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.vercel.com/v10/projects/prj_abcd1234efgh5678/promote/dpl_target00000001?teamId=team_z1');
  });

  it('rollback POSTs /v1/projects/{id}/rollback/{deploymentId} with an optional description', async () => {
    const { fetchImpl, calls } = mutationRecorder([{ status: 200, body: {} }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    await client.rollback({ projectId: 'prj_abcd1234efgh5678', teamId: null }, 'dpl_prev000000001', 'bad deploy');
    expect(calls[0]!.url).toBe('https://api.vercel.com/v1/projects/prj_abcd1234efgh5678/rollback/dpl_prev000000001');
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ description: 'bad deploy' });
  });

  // Regression: Vercel promote/rollback return 204 No Content (empty body). The client must treat that as a
  // successful no-content response, NOT force JSON parsing (which throws and would surface a false `ambiguous`).
  it('promote succeeds on a 204 No Content (empty body) — no JSON parse, no throw', async () => {
    const { fetchImpl, calls } = mutationRecorder([{ status: 204, empty: true }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    await expect(client.promote({ projectId: 'prj_abcd1234efgh5678', teamId: null }, 'dpl_target00000001')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/v10/projects/prj_abcd1234efgh5678/promote/dpl_target00000001');
  });

  it('rollback succeeds on a 204 No Content (empty body) — no JSON parse, no throw', async () => {
    const { fetchImpl, calls } = mutationRecorder([{ status: 204, empty: true }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    await expect(client.rollback({ projectId: 'prj_abcd1234efgh5678', teamId: null }, 'dpl_prev000000001')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/v1/projects/prj_abcd1234efgh5678/rollback/dpl_prev000000001');
  });

  it('redeploy still parses its JSON body (empty-body handling does not affect responses that carry content)', async () => {
    const { fetchImpl } = mutationRecorder([{ status: 200, body: { id: 'dpl_new000000001', readyState: 'QUEUED' } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    const out = await client.redeploy({ projectId: 'prj_abcd1234efgh5678', teamId: null }, { name: 'accuratebids', sourceDeploymentId: 'dpl_src000000001' });
    expect(out).toEqual({ deploymentId: 'dpl_new000000001', readyState: 'QUEUED' });
  });

  it('redeploy POSTs /v13/deployments with name + source deploymentId and returns the new id', async () => {
    const { fetchImpl, calls } = mutationRecorder([{ status: 200, body: { id: 'dpl_new000000001', readyState: 'QUEUED' } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    const out = await client.redeploy({ projectId: 'prj_abcd1234efgh5678', teamId: null }, { name: 'accuratebids', sourceDeploymentId: 'dpl_src000000001' });
    expect(calls[0]!.url).toBe('https://api.vercel.com/v13/deployments');
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({ name: 'accuratebids', deploymentId: 'dpl_src000000001' });
    expect(out).toEqual({ deploymentId: 'dpl_new000000001', readyState: 'QUEUED' });
  });

  it('getProjectState reads the current production deployment id + SHA', async () => {
    const { fetchImpl } = mutationRecorder([{ status: 200, body: { name: 'accuratebids', targets: { production: { id: 'dpl_prod00000001', meta: { githubCommitSha: 'a'.repeat(40) } } } } }]);
    const client = new LiveVercelClient({ token: 'vt_test', fetchImpl });
    const state = await client.getProjectState({ projectId: 'prj_abcd1234efgh5678', teamId: null });
    expect(state).toMatchObject({ name: 'accuratebids', productionDeploymentId: 'dpl_prod00000001', productionSha: 'a'.repeat(40) });
  });
});
