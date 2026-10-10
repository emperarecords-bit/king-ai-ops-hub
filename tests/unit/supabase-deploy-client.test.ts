import { afterEach, describe, expect, it } from 'vitest';
import {
  getSupabaseDeployClient,
  resetSupabaseClientForTests,
  setSupabaseDeployClientOverrideForTests,
  SupabaseUnconfiguredError,
} from '@/domain/supabase/client';
import { LiveSupabaseManagementClient, SupabaseApiError, type SupabaseFetchLike } from '@/domain/supabase/live-client';

/**
 * Phase 2C write slice — the Supabase deploy client. Without the owner-gated token the WRITE surface fails closed
 * exactly like the read surface. The live client speaks the Management bundle-deploy endpoint over an injected
 * fetch (no network): a multipart body with a `metadata` part + one `file` part per source file, a bearer token,
 * and status-only errors. getEdgeFunction maps 404 → null.
 */

const REF = { projectRef: 'bblnywrcdsfdasytkzps' };

afterEach(() => {
  setSupabaseDeployClientOverrideForTests(null);
  resetSupabaseClientForTests();
  delete process.env.SUPABASE_MANAGEMENT_TOKEN;
});

describe('getSupabaseDeployClient — fail closed without the token', () => {
  it('both methods reject with SupabaseUnconfiguredError when the token is absent, performing no I/O', async () => {
    delete process.env.SUPABASE_MANAGEMENT_TOKEN;
    const client = getSupabaseDeployClient();
    await expect(client.deployEdgeFunction(REF, { slug: 's', entrypointPath: 'index.ts', importMapPath: null, verifyJwt: false, files: [{ path: 'index.ts', content: 'x' }] })).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
    await expect(client.getEdgeFunction(REF, 's')).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
  });

  it('a test override is returned when set', () => {
    const fake = { deployEdgeFunction: async () => ({ slug: 's', version: 1 }), getEdgeFunction: async () => null };
    setSupabaseDeployClientOverrideForTests(fake);
    expect(getSupabaseDeployClient()).toBe(fake);
  });
});

function recorder(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: FormData | string }> = [];
  let i = 0;
  const fetchImpl: SupabaseFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses[i++] ?? { status: 200, body: {} };
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { fetchImpl, calls };
}

describe('LiveSupabaseManagementClient.deployEdgeFunction — wire shape', () => {
  it('POSTs the bundle-deploy endpoint with slug query, bearer, and a multipart metadata + file body', async () => {
    const { fetchImpl, calls } = recorder([{ status: 200, body: { slug: 'approve-quote', version: 33 } }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_test', fetchImpl });
    const out = await client.deployEdgeFunction(REF, {
      slug: 'approve-quote',
      entrypointPath: 'index.ts',
      importMapPath: null,
      verifyJwt: false,
      files: [{ path: 'index.ts', content: 'export default 1' }, { path: '_shared/u.ts', content: 'export const u=1' }],
    });
    expect(out).toEqual({ slug: 'approve-quote', version: 33 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.supabase.com/v1/projects/bblnywrcdsfdasytkzps/functions/deploy?slug=approve-quote');
    expect(calls[0]!.headers.authorization).toBe('Bearer sbp_test');
    // No manual content-type — the platform sets the multipart boundary for the FormData.
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    const body = calls[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const metadata = JSON.parse(body.get('metadata') as string);
    expect(metadata).toMatchObject({ name: 'approve-quote', entrypoint_path: 'index.ts', verify_jwt: false });
    expect(body.getAll('file')).toHaveLength(2);
  });

  it('includes import_map_path in metadata only when set', async () => {
    const { fetchImpl, calls } = recorder([{ status: 201, body: { slug: 's', version: 1 } }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_test', fetchImpl });
    await client.deployEdgeFunction(REF, { slug: 's', entrypointPath: 'index.ts', importMapPath: 'import_map.json', verifyJwt: true, files: [{ path: 'index.ts', content: 'x' }] });
    const metadata = JSON.parse((calls[0]!.body as FormData).get('metadata') as string);
    expect(metadata.import_map_path).toBe('import_map.json');
    expect(metadata.verify_jwt).toBe(true);
  });

  it('a non-2xx deploy throws a status-only SupabaseApiError (no body echoed)', async () => {
    const { fetchImpl } = recorder([{ status: 403, body: { message: 'secret detail' } }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_test', fetchImpl });
    let caught: unknown;
    try {
      await client.deployEdgeFunction(REF, { slug: 's', entrypointPath: 'index.ts', importMapPath: null, verifyJwt: false, files: [{ path: 'index.ts', content: 'x' }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ name: 'SupabaseApiError', status: 403 });
    // Status-only — the response body is never echoed into the error message.
    expect((caught as Error).message).not.toMatch(/secret detail/);
  });
});

describe('LiveSupabaseManagementClient.getEdgeFunction', () => {
  it('returns a summary on 200 and null on 404', async () => {
    const { fetchImpl } = recorder([
      { status: 200, body: { slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: 32, verify_jwt: false, updated_at: '2026-10-09T00:00:00Z' } },
      { status: 404, body: {} },
    ]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_test', fetchImpl });
    expect(await client.getEdgeFunction(REF, 'approve-quote')).toMatchObject({ slug: 'approve-quote', version: 32 });
    expect(await client.getEdgeFunction(REF, 'gone')).toBeNull();
  });

  it('throws SupabaseApiError on a non-200/404 status', async () => {
    const { fetchImpl } = recorder([{ status: 500, body: {} }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_test', fetchImpl });
    await expect(client.getEdgeFunction(REF, 's')).rejects.toBeInstanceOf(SupabaseApiError);
  });
});
