/**
 * REAL integration test for VER-002 PR-6 — aggregate storage quota against Postgres.
 *
 * What only a real database can prove:
 *   - CONCURRENCY: N racing reservations against a fixed cap cannot oversubscribe. §4.6's whole argument
 *     is that one conditional UPDATE removes the read-then-write race, and that is not testable in-process.
 *   - app_server cannot touch the counter directly and cannot call refund.
 *   - the PR-6 ↔ PR-7 seam: a confirmed deletion refunds exactly the GRANT's declared_size, once.
 *
 * OPT-IN like the other .int.test.ts suites: self-skips unless VER_QUOTA_DB_URL points at a DISPOSABLE
 * database with migration 0090 and src/db/rls.sql applied. Refuses the shared `king_ai_hub`.
 *   createdb king_ai_hub_pr6_verify
 *   DATABASE_URL=... DATABASE_MIGRATION_URL=... GBACKUP_DECLARED_BOOTSTRAP=1 \
 *     GBACKUP_EXPECTED_DB_IDENTITY=king_ai_hub_pr6_verify npx tsx scripts/migrate.ts
 *   VER_QUOTA_DB_URL=<that url> npx vitest run tests/integration/verification-quota.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.VER_QUOTA_DB_URL ?? '';
const SHARED = 'king_ai_hub';
const dbName = (u: string): string => { try { return new URL(u).pathname.replace(/^\//, ''); } catch { return ''; } };
if (DB_URL && dbName(DB_URL) === SHARED) throw new Error(`VER_QUOTA_DB_URL must not be the shared ${SHARED} database`);
const enabled = Boolean(DB_URL) && dbName(DB_URL) !== SHARED;

const asRole = (r: string, pw: string): string => { const u = new URL(DB_URL); u.username = r; u.password = pw; return u.toString(); };

type Sql = ReturnType<typeof postgres>;
let owner: Sql;
let app: Sql;
let ret: Sql;

const org = randomUUID(), proj = randomUUID(), prof = randomUUID(), task = randomUUID(), req = randomUUID();
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const CAP = 1000;

const guc = async (tx: Sql, o = org, p = proj): Promise<unknown> =>
  tx.unsafe(`select set_config('app.org_id',$1,true), set_config('app.project_id',$2,true), set_config('app.user_id',$3,true)`, [o, p, prof]);

const usage = async (o = org, p = proj) => (await owner.unsafe(
  `select cap_bytes::int as cap, reserved_bytes::int as res, committed_bytes::int as com
     from verification_storage_quota where org_id=$1 and project_id=$2`, [o, p]))[0] ?? null;

const reserve = (n: number, cap = CAP): Promise<boolean> => app.begin(async (tx) => {
  await guc(tx as unknown as Sql);
  return (await tx.unsafe(`select app.reserve_verification_quota($1::bigint, $2::bigint) as ok`, [n, cap]))[0]!.ok as boolean;
});
const finalize = (n: number): Promise<boolean> => app.begin(async (tx) => {
  await guc(tx as unknown as Sql);
  return (await tx.unsafe(`select app.finalize_verification_quota($1::bigint) as ok`, [n]))[0]!.ok as boolean;
});

describe.skipIf(!enabled)('PR-6 quota (real Postgres)', () => {
  beforeAll(async () => {
    owner = postgres(DB_URL, { max: 4, onnotice: () => {} });
    app = postgres(asRole('app_server', process.env.APP_SERVER_PASSWORD ?? 'app_server_dev_only'), { max: 25, onnotice: () => {} });
    ret = postgres(asRole('verification_retention_agent', process.env.VERIFICATION_RETENTION_AGENT_PASSWORD ?? 'verification_retention_dev_only'), { max: 1, onnotice: () => {} });
    await owner.unsafe(`insert into organizations (id, name, slug) values ($1,'PR6','pr6-${org.slice(0, 8)}')`, [org]);
    await owner.unsafe(`insert into profiles (id, email, display_name) values ($1,'pr6-${prof.slice(0, 8)}@example.test','PR6')`, [prof]);
    await owner.unsafe(`insert into projects (id, org_id, key, name) values ($1,$2,'pr6-${proj.slice(0, 8)}','PR6')`, [proj, org]);
    await owner.unsafe(`insert into tasks (id, org_id, project_id, title, status, created_by, input, provider_selection)
       values ($1,$2,$3,'t','pending',$4,'{}',
         (select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='provider_selection' order by e.enumsortorder limit 1)::provider_selection)`, [task, org, proj, prof]);
    await owner.unsafe(`insert into verification_requests (id, org_id, project_id, task_id, repo_full_name, expected_commit_sha, required_checks)
       values ($1,$2,$3,$4,'acme/repo',$5,'[]'::jsonb)`, [req, org, proj, task, SHA]);
  });

  afterAll(async () => { await Promise.all([owner?.end(), app?.end(), ret?.end()]); });

  it('app_server may reserve and finalize but may NOT write the row or refund', async () => {
    const p = (await owner.unsafe(`select
        has_table_privilege('app_server','verification_storage_quota','select') as sel,
        has_table_privilege('app_server','verification_storage_quota','insert') as ins,
        has_table_privilege('app_server','verification_storage_quota','update') as upd,
        has_function_privilege('app_server','app.reserve_verification_quota(bigint,bigint)','execute') as res_x,
        has_function_privilege('app_server','app.finalize_verification_quota(bigint)','execute') as fin_x,
        has_function_privilege('app_server','app.refund_verification_quota(bigint)','execute') as ref_x,
        has_function_privilege('verification_retention_agent','app.refund_verification_quota(bigint)','execute') as ret_x`))[0]!;
    expect(p).toMatchObject({ sel: true, ins: false, upd: false, res_x: true, fin_x: true, ref_x: false, ret_x: true });
  });

  it('a direct UPDATE of the counter by app_server is refused', async () => {
    await expect(app.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      await tx.unsafe(`update verification_storage_quota set cap_bytes = 999999999`);
    })).rejects.toThrow(/permission denied/i);
  });

  it('app_server calling refund is refused', async () => {
    await expect(app.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      await tx.unsafe(`select app.refund_verification_quota(500::bigint)`);
    })).rejects.toThrow();
  });

  it('reserve seeds the row, fills exactly to the cap, and refuses one byte over', async () => {
    expect(await reserve(400)).toBe(true);
    expect(await reserve(600)).toBe(true);
    expect(await usage()).toMatchObject({ cap: CAP, res: 1000, com: 0 });
    expect(await reserve(1)).toBe(false);
    expect(await usage()).toMatchObject({ res: 1000, com: 0 }); // refusal changed nothing
  });

  it('finalize moves reserved → committed and leaves the TOTAL unchanged', async () => {
    const before = (await usage())!;
    expect(await finalize(400)).toBe(true);
    const after = (await usage())!;
    expect(after).toMatchObject({ res: 600, com: 400 });
    expect(after.res + after.com).toBe(before.res + before.com);
    expect(await reserve(1)).toBe(false); // still full: finalize frees nothing
    expect(await finalize(99999)).toBe(false);
    expect((await usage())!.com).toBe(400); // a failed finalize invents nothing
  });

  it('CONCURRENCY: 20 racing 100-byte reservations against a 1000-byte cap yield exactly 10 winners', async () => {
    const org2 = randomUUID(), proj2 = randomUUID();
    await owner.unsafe(`insert into organizations (id, name, slug) values ($1,'PR6b','pr6b-${org2.slice(0, 8)}')`, [org2]);
    await owner.unsafe(`insert into projects (id, org_id, key, name) values ($1,$2,'pr6b-${proj2.slice(0, 8)}','PR6b')`, [proj2, org2]);
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      app.begin(async (tx) => {
        await guc(tx as unknown as Sql, org2, proj2);
        return (await tx.unsafe(`select app.reserve_verification_quota(100::bigint, 1000::bigint) as ok`))[0]!.ok as boolean;
      })));
    expect(results.filter((r) => r === true).length).toBe(10);
    expect((await usage(org2, proj2))!.res).toBe(1000); // never exceeded the cap
  });

  it('the PR-6 ↔ PR-7 seam: a confirmed deletion refunds exactly the grant size, once', async () => {
    const grantId = randomUUID();
    await owner.unsafe(`insert into verification_upload_grants
        (id, org_id, project_id, request_id, attempt_id, logical_path, object_key, declared_size, declared_sha256, expires_at, max_upload_ms)
      values ($1,$2,$3,$4,'att-seam','p/seam','obj/seam',400,$5, now() + interval '1 hour', 60000)`,
      [grantId, org, proj, req, 'f'.repeat(64)]);
    const ev = randomUUID();
    await owner.unsafe(`insert into verification_evidence
        (id, org_id, project_id, request_id, task_id, idempotency_key, attempt_id, commit_sha, repo_full_name,
         run_id, runner_id, source, environment, status, accepted, decided_at, checks, artifacts, reasons, artifact_availability, submission_sha256)
      values ($1,$2,$3,$4,$5,'idem-seam','att-seam',$6,'acme/repo','run-1','runner-1','external_runner','ci','accepted',true,now(),
         '[]'::jsonb,$7::text::jsonb,'[]'::jsonb,'[]'::jsonb,$8)`,
      [ev, org, proj, req, task, SHA,
        JSON.stringify([{ path: 'p/seam', sha256: 'f'.repeat(64), sizeBytes: 400, storageKey: 'obj/seam' }]), 'e'.repeat(64)]);

    const committedBefore = (await usage())!.com;
    const jobId = await ret.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      return String((await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'retention_expiry') as j`, [[ev]]))[0]!.j);
    });
    const objs = await owner.unsafe(`select id, quota_bytes::int as qb from verification_purge_job_objects where job_id=$1`, [jobId]);
    expect(objs.length).toBe(1);
    expect(objs[0]!.qb).toBe(400); // resolved from the GRANT, not the artifact
    expect((await usage())!.com).toBe(committedBefore); // not refunded until confirmed gone

    const confirm = async (): Promise<void> => { await ret.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      await tx.unsafe(`select app.record_verification_purge_object_deleted($1)`, [objs[0]!.id]);
    }); };
    await confirm();
    expect((await usage())!.com).toBe(committedBefore - 400);
    const afterOnce = (await usage())!.com;
    await confirm(); // idempotent: refunds nothing the second time
    expect((await usage())!.com).toBe(afterOnce);
  });

  it('an object with no matching grant refunds 0 — never free quota', async () => {
    const ev = randomUUID();
    await owner.unsafe(`insert into verification_evidence
        (id, org_id, project_id, request_id, task_id, idempotency_key, attempt_id, commit_sha, repo_full_name,
         run_id, runner_id, source, environment, status, accepted, decided_at, checks, artifacts, reasons, artifact_availability, submission_sha256)
      values ($1,$2,$3,$4,$5,'idem-nogrant','att-nogrant',$6,'acme/repo','run-1','runner-1','external_runner','ci','accepted',true,now(),
         '[]'::jsonb,$7::text::jsonb,'[]'::jsonb,'[]'::jsonb,$8)`,
      [ev, org, proj, req, task, SHA,
        JSON.stringify([{ path: 'p/ungranted', sha256: 'f'.repeat(64), sizeBytes: 999, storageKey: 'obj/ungranted' }]), 'd'.repeat(64)]);
    const jobId = await ret.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      return String((await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'retention_expiry') as j`, [[ev]]))[0]!.j);
    });
    const o = (await owner.unsafe(`select id, quota_bytes::int as qb from verification_purge_job_objects where job_id=$1`, [jobId]))[0]!;
    expect(o.qb).toBe(0);
    const before = (await usage())!.com;
    await ret.begin(async (tx) => {
      await guc(tx as unknown as Sql);
      await tx.unsafe(`select app.record_verification_purge_object_deleted($1)`, [o.id]);
    });
    expect((await usage())!.com).toBe(before);
  });

  it('the CHECK constraints refuse a negative counter even for the owner', async () => {
    await expect(owner.unsafe(`update verification_storage_quota set committed_bytes = -1 where org_id=$1`, [org]))
      .rejects.toThrow(/committed_nonneg|violates check/i);
  });
});
