import { afterEach, describe, expect, it } from 'vitest';
import {
  getSupabaseClient,
  isSupabaseConfigured,
  resetSupabaseClientForTests,
  setSupabaseClientOverrideForTests,
  SupabaseUnconfiguredError,
  type SupabaseManagementClient,
} from '@/domain/supabase/client';
import { LiveSupabaseManagementClient, SupabaseApiError, type SupabaseFetchLike } from '@/domain/supabase/live-client';

/**
 * Supabase Management client (Phase 2C, read-only). Without the owner-gated SUPABASE_MANAGEMENT_TOKEN every
 * method fails closed. The live client speaks the Management REST API over an injected fetch (no network), with
 * a bearer token and status-only errors.
 */

const REF = { projectRef: 'bblnywrcdsfdasytkzps' };

afterEach(() => {
  setSupabaseClientOverrideForTests(null);
  resetSupabaseClientForTests();
  delete process.env.SUPABASE_MANAGEMENT_TOKEN;
});

describe('getSupabaseClient — fail closed without the token', () => {
  it('isSupabaseConfigured reflects the token presence', () => {
    delete process.env.SUPABASE_MANAGEMENT_TOKEN;
    expect(isSupabaseConfigured()).toBe(false);
    process.env.SUPABASE_MANAGEMENT_TOKEN = 'sbp_x';
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('every method rejects with SupabaseUnconfiguredError when the token is absent, performing no I/O', async () => {
    delete process.env.SUPABASE_MANAGEMENT_TOKEN;
    const client = getSupabaseClient();
    await expect(client.getProject(REF)).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
    await expect(client.listEdgeFunctions(REF)).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
    await expect(client.listMigrations(REF)).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
  });

  it('a test override is honored and clearable', async () => {
    const fake: SupabaseManagementClient = {
      getProject: async () => ({ ref: REF.projectRef, name: 'AccurateBids', region: 'us-east-1', status: 'ACTIVE_HEALTHY', databaseVersion: '15.1' }),
      listEdgeFunctions: async () => [],
      listMigrations: async () => [],
    };
    setSupabaseClientOverrideForTests(fake);
    expect(await getSupabaseClient().getProject(REF)).toMatchObject({ name: 'AccurateBids' });
    setSupabaseClientOverrideForTests(null);
    delete process.env.SUPABASE_MANAGEMENT_TOKEN;
    await expect(getSupabaseClient().getProject(REF)).rejects.toBeInstanceOf(SupabaseUnconfiguredError);
  });
});

describe('LiveSupabaseManagementClient — read methods over an injected fetch', () => {
  function recorder(status: number, body: unknown): { fetchImpl: SupabaseFetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: SupabaseFetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status, json: async () => body };
    };
    return { fetchImpl, calls };
  }

  it('getProject reads /v1/projects/{ref} with a bearer token and maps the summary', async () => {
    const { fetchImpl, calls } = recorder(200, { id: REF.projectRef, name: 'AccurateBids', region: 'us-east-1', status: 'ACTIVE_HEALTHY', database: { version: '15.1' } });
    const client = new LiveSupabaseManagementClient({ token: 'sbp_abc', fetchImpl });
    const info = await client.getProject(REF);
    expect(info).toEqual({ ref: REF.projectRef, name: 'AccurateBids', region: 'us-east-1', status: 'ACTIVE_HEALTHY', databaseVersion: '15.1' });
    expect(calls[0]!.url).toBe(`https://api.supabase.com/v1/projects/${REF.projectRef}`);
    expect(calls[0]!.headers.authorization).toBe('Bearer sbp_abc');
  });

  it('listEdgeFunctions maps slug/status/version/verify_jwt', async () => {
    const { fetchImpl } = recorder(200, [{ slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: 32, verify_jwt: false, updated_at: '2026-10-09T00:00:00Z' }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_abc', fetchImpl });
    const fns = await client.listEdgeFunctions(REF);
    expect(fns).toEqual([{ slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: 32, verifyJwt: false, updatedAt: '2026-10-09T00:00:00Z' }]);
  });

  it('listMigrations maps version + name', async () => {
    const { fetchImpl } = recorder(200, [{ version: '20261009000000', name: 'contractor_recorded_quote_approval' }]);
    const client = new LiveSupabaseManagementClient({ token: 'sbp_abc', fetchImpl });
    expect(await client.listMigrations(REF)).toEqual([{ version: '20261009000000', name: 'contractor_recorded_quote_approval' }]);
  });

  it('a non-200 is a status-only SupabaseApiError (no body echoed)', async () => {
    const { fetchImpl } = recorder(404, { message: 'nope' });
    const client = new LiveSupabaseManagementClient({ token: 'sbp_abc', fetchImpl });
    await expect(client.getProject(REF)).rejects.toMatchObject({ name: 'SupabaseApiError', status: 404 });
    await expect(client.getProject(REF)).rejects.toThrow(/HTTP 404/);
    const err = await client.getProject(REF).catch((e) => e);
    expect(err).toBeInstanceOf(SupabaseApiError);
    expect(String(err)).not.toContain('nope');
  });
});
