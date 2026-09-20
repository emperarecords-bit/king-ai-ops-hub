/**
 * PR-1 regression: evidence immutability + verification FK RESTRICT (VER-002).
 *
 * DB-level guarantees, verified on a DISPOSABLE *_test database — never production, never real creds.
 * Four things are asserted SEPARATELY (see the design's §3):
 *   1. `app_server` cannot UPDATE or DELETE evidence           → blocked at the GRANT layer.
 *   2. The append-only TRIGGER rejects a mutation even from a  → blocked by app.forbid_mutation(),
 *      disposable role that DOES hold UPDATE/DELETE grants.       independent of the grant.
 *   3. ON DELETE RESTRICT blocks parent deletion and preserves → the FK constraint rejects the delete;
 *      evidence (a contract WITHOUT evidence also blocks).        the cascade is PREVENTED, so this does
 *                                                                 NOT exercise the append-only trigger.
 * (Fresh-bootstrap / upgrade / ingestion+idempotent-retry are exercised by the harness + the existing
 *  verification-ingest integration test, not here.)
 *
 * Prereqs (all local/isolated): VER_IMM_SUPER_URL (superuser, for seeding + role/parent-delete cases),
 * VER_IMM_APP_URL (the non-superuser app_server role). Self-skips unless both are set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const SUPER = process.env.VER_IMM_SUPER_URL ?? '';
const APP = process.env.VER_IMM_APP_URL ?? '';
const enabled = Boolean(SUPER && APP);

function assertDisposable(url: string): void {
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw new Error(`refusing non-local host: ${u.hostname}`);
  const db = u.pathname.replace(/^\//, '');
  if (!/_test$/.test(db)) throw new Error(`refusing DB that is not *_test: ${db}`);
  if (/prod|production|staging/i.test(`${u.hostname}/${db}`)) throw new Error(`refusing prod/staging: ${db}`);
}

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJ = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const EVID = '55555555-5555-4555-8555-555555555555';
// A SECOND project/task/request with NO evidence — to prove a contract without evidence also blocks.
const PROJ2 = '66666666-6666-4666-8666-666666666666';
const TASK2 = '77777777-7777-4777-8777-777777777777';
const REQ2 = '88888888-8888-4888-8888-888888888888';
const CREATOR = '99999999-9999-4999-8999-999999999999';
const TAMPER_ROLE = 'ver_imm_tamper_test';

let sup: postgres.Sql;
let app: postgres.Sql;

/** Drop the disposable role, first releasing its grants (else DROP ROLE fails on dependent objects). */
async function dropTamperRole(): Promise<void> {
  await sup`do $$ begin
    if exists (select 1 from pg_roles where rolname = 'ver_imm_tamper_test') then
      execute 'drop owned by ver_imm_tamper_test';
      execute 'drop role ver_imm_tamper_test';
    end if;
  end $$`;
}

beforeAll(async () => {
  if (!enabled) return;
  assertDisposable(SUPER);
  assertDisposable(APP);
  sup = postgres(SUPER, { max: 2, prepare: false });
  app = postgres(APP, { max: 2, prepare: false });

  // Seed as superuser (bypasses RLS; append-only trigger only fires on UPDATE/DELETE, so INSERT is fine).
  await sup`insert into profiles (id, email, display_name) values (${CREATOR}, 'imm@example.com', 'Imm') on conflict do nothing`;
  await sup`insert into organizations (id, name, slug) values (${ORG}, 'ImmOrg', 'imm-org') on conflict do nothing`;
  await sup`insert into projects (id, org_id, key, name) values (${PROJ}, ${ORG}, 'immproj', 'ImmProj') on conflict do nothing`;
  await sup`insert into projects (id, org_id, key, name) values (${PROJ2}, ${ORG}, 'immproj2', 'ImmProj2') on conflict do nothing`;
  await sup`insert into tasks (id, org_id, project_id, title, input, provider_selection, status, review_enabled, created_by)
            values (${TASK}, ${ORG}, ${PROJ}, 'T', 'in', 'both', 'completed', true, ${CREATOR}) on conflict do nothing`;
  await sup`insert into tasks (id, org_id, project_id, title, input, provider_selection, status, review_enabled, created_by)
            values (${TASK2}, ${ORG}, ${PROJ2}, 'T2', 'in', 'both', 'completed', true, ${CREATOR}) on conflict do nothing`;
  const reqCols = sup`(id, org_id, project_id, task_id, repo_full_name, expected_commit_sha, required_checks, required_artifacts)`;
  await sup`insert into verification_requests ${reqCols}
            values (${REQ}, ${ORG}, ${PROJ}, ${TASK}, 'acme/widget', ${'a'.repeat(40)}, ${sup.json(['unit'])}, ${sup.json([])}) on conflict do nothing`;
  await sup`insert into verification_requests ${reqCols}
            values (${REQ2}, ${ORG}, ${PROJ2}, ${TASK2}, 'acme/widget', ${'b'.repeat(40)}, ${sup.json(['unit'])}, ${sup.json([])}) on conflict do nothing`;
  // Evidence ONLY for req1 (req2 stays evidence-free on purpose).
  await sup`insert into verification_evidence
              (id, org_id, project_id, task_id, request_id, repo_full_name, commit_sha, dirty, runner_id, run_id,
               attempt_id, environment, source, checks, artifacts, artifact_availability, idempotency_key,
               submission_sha256, accepted, status, deliverable, reasons, decided_at)
            values (${EVID}, ${ORG}, ${PROJ}, ${TASK}, ${REQ}, 'acme/widget', ${'a'.repeat(40)}, false, 'runner-1',
               'run-1', 'attempt-1', 'local', 'local_runner', ${sup.json([])}, ${sup.json([])}, ${sup.json([])},
               'idem-1', ${'c'.repeat(64)}, true, 'verified_complete', true, ${sup.json([])}, now())
            on conflict do nothing`;

  // A disposable role that DOES hold UPDATE/DELETE AND can see the row (BYPASSRLS) — so the ONLY thing
  // that can stop the mutation is the append-only trigger (BYPASSRLS bypasses RLS, never triggers).
  await dropTamperRole();
  await sup`create role ${sup(TAMPER_ROLE)} nologin bypassrls`;
  await sup`grant usage on schema public to ${sup(TAMPER_ROLE)}`;
  await sup`grant select, update, delete on verification_evidence to ${sup(TAMPER_ROLE)}`;
});

afterAll(async () => {
  if (!enabled) return;
  try { await dropTamperRole(); } catch { /* best effort */ }
  await sup?.end({ timeout: 5 });
  await app?.end({ timeout: 5 });
});

describe.skipIf(!enabled)('VER-002 PR-1 — evidence immutability + FK RESTRICT', () => {
  it('1. app_server cannot UPDATE or DELETE evidence (grant layer)', async () => {
    const [who] = await app`select current_user as u, rolsuper, rolbypassrls
                            from pg_roles where rolname = current_user` as unknown as Array<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(who?.rolsuper, 'app role must not be superuser').toBe(false);
    expect(who?.rolbypassrls, 'app role must not bypass RLS').toBe(false);
    await expect(app`update verification_evidence set status = 'tampered' where id = ${EVID}`).rejects.toThrow(/permission denied/i);
    await expect(app`delete from verification_evidence where id = ${EVID}`).rejects.toThrow(/permission denied/i);
  });

  it('2. append-only trigger rejects mutation by a role that HAS update/delete grants', async () => {
    // SET ROLE to the disposable grant-holding role, so the failure can ONLY come from the trigger.
    await expect(
      sup.begin(async (tx) => {
        await tx`set local role ${tx(TAMPER_ROLE)}`;
        await tx`update verification_evidence set status = 'tampered' where id = ${EVID}`;
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      sup.begin(async (tx) => {
        await tx`set local role ${tx(TAMPER_ROLE)}`;
        await tx`delete from verification_evidence where id = ${EVID}`;
      }),
    ).rejects.toThrow(/append-only/i);
    // The row is untouched.
    const [row] = await sup`select status from verification_evidence where id = ${EVID}` as unknown as Array<{ status: string }>;
    expect(row?.status).toBe('verified_complete');
  });

  it('3. RESTRICT blocks parent deletion and preserves evidence (cascade is prevented, not triggered)', async () => {
    // Deleting any parent of a contract-with-evidence is rejected by the FK, before any cascade runs.
    for (const del of [
      sup`delete from organizations where id = ${ORG}`,
      sup`delete from projects where id = ${PROJ}`,
      sup`delete from tasks where id = ${TASK}`,
      sup`delete from verification_requests where id = ${REQ}`,
    ]) {
      await expect(del).rejects.toThrow(/violates foreign key constraint/i);
    }
    // Everything survives.
    const [ev] = await sup`select 1 as ok from verification_evidence where id = ${EVID}` as unknown as Array<{ ok: number }>;
    expect(ev?.ok).toBe(1);
    const [org] = await sup`select 1 as ok from organizations where id = ${ORG}` as unknown as Array<{ ok: number }>;
    expect(org?.ok).toBe(1);
  });

  it('3b. a contract WITHOUT evidence also blocks parent deletion (request→parent is RESTRICT)', async () => {
    // req2/task2/proj2 have NO evidence, yet the request itself blocks its parents.
    for (const del of [
      sup`delete from projects where id = ${PROJ2}`,
      sup`delete from tasks where id = ${TASK2}`,
    ]) {
      await expect(del).rejects.toThrow(/violates foreign key constraint/i);
    }
    const [req2] = await sup`select 1 as ok from verification_requests where id = ${REQ2}` as unknown as Array<{ ok: number }>;
    expect(req2?.ok).toBe(1);
  });

  it('4. ingestion INSERT + identical idempotent retry still succeed for app_server (happy path intact)', async () => {
    const KEY = 'idem-retry';
    const IDA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const IDB = 'aaaaaaaa-0000-4000-8000-000000000002';
    const insertEvidence = (id: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${ORG}, true), set_config('app.project_id', ${PROJ}, true), set_config('app.user_id', ${CREATOR}, true)`;
        await tx`insert into verification_evidence
                   (id, org_id, project_id, task_id, request_id, repo_full_name, commit_sha, dirty, runner_id, run_id,
                    attempt_id, environment, source, checks, artifacts, artifact_availability, idempotency_key,
                    submission_sha256, accepted, status, deliverable, reasons, decided_at)
                 values (${id}, ${ORG}, ${PROJ}, ${TASK}, ${REQ}, 'acme/widget', ${'a'.repeat(40)}, false, 'runner-1',
                    'run-2', 'attempt-2', 'local', 'local_runner', ${app.json([])}, ${app.json([])}, ${app.json([])},
                    ${KEY}, ${'d'.repeat(64)}, true, 'verified_complete', true, ${app.json([])}, now())
                 on conflict do nothing`;
      });
    // First insert lands as app_server (INSERT grant + RLS with-check satisfied; trigger doesn't fire on INSERT).
    await insertEvidence(IDA);
    // Identical retry: same (org, project, request, idempotency_key) → ON CONFLICT DO NOTHING, no error, no dup.
    await insertEvidence(IDB); // must not throw
    const [c] = await sup`select count(*)::int as n from verification_evidence
                          where request_id = ${REQ} and idempotency_key = ${KEY}` as unknown as Array<{ n: number }>;
    expect(c?.n).toBe(1);
  });
});
