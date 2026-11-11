/**
 * REAL integration test for VER-002 PR-7 — the retention / purge lifecycle against Postgres.
 *
 * What only a real database can prove, and therefore what this covers:
 *   - app_server CANNOT delete verification_evidence (PR-1's guarantee survives PR-7),
 *   - UPDATE on evidence is still refused for EVERY role, including the table owner,
 *   - the object list is committed in the SAME transaction that removes the references,
 *   - the job completes only when the last object is confirmed gone,
 *   - a failure increments attempts and leaves the object pending,
 *   - an invalid reason is refused by the function, not by the caller.
 *
 * OPT-IN, like the other .int.test.ts suites: self-skips unless VER_RET_DB_URL points at a DISPOSABLE
 * database that already has migration 0089 and src/db/rls.sql applied. It refuses to run against the
 * shared `king_ai_hub`. Create one with:
 *   createdb king_ai_hub_pr7_verify
 *   DATABASE_URL=... DATABASE_MIGRATION_URL=... GBACKUP_DECLARED_BOOTSTRAP=1 \
 *     GBACKUP_EXPECTED_DB_IDENTITY=king_ai_hub_pr7_verify npx tsx scripts/migrate.ts
 *   VER_RET_DB_URL=<that url> npx vitest run tests/integration/verification-retention.int.test.ts
 *
 * No provisioning, no server, no object store — the deleter is not involved here; this is the DB contract.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.VER_RET_DB_URL ?? '';
const SHARED = 'king_ai_hub';
const dbName = (u: string): string => { try { return new URL(u).pathname.replace(/^\//, ''); } catch { return ''; } };
const enabled = Boolean(DB_URL) && dbName(DB_URL) !== SHARED;

if (DB_URL && dbName(DB_URL) === SHARED) {
  throw new Error(`VER_RET_DB_URL must not be the shared ${SHARED} database — use a disposable one`);
}

const RETENTION_PW = process.env.VERIFICATION_RETENTION_AGENT_PASSWORD ?? 'verification_retention_dev_only';
const APP_PW = process.env.APP_SERVER_PASSWORD ?? 'app_server_dev_only';
const asRole = (role: string, pw: string): string => { const u = new URL(DB_URL); u.username = role; u.password = pw; return u.toString(); };

type Sql = ReturnType<typeof postgres>;
let owner: Sql;
let retention: Sql;
let app: Sql;

const org = randomUUID(), proj = randomUUID(), prof = randomUUID(), task = randomUUID(), req = randomUUID();
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** Stamp the tenant GUCs the way withTenant/withRetentionTenant do. */
const tenant = async (tx: Sql) => {
  await tx.unsafe(`select set_config('app.org_id',$1,true), set_config('app.project_id',$2,true), set_config('app.user_id',$3,true)`, [org, proj, prof]);
};

async function seedEvidence(storageKeys: readonly string[]): Promise<string> {
  const id = randomUUID();
  await owner.unsafe(
    `insert into verification_evidence
       (id, org_id, project_id, request_id, task_id, idempotency_key, attempt_id, commit_sha, repo_full_name,
        run_id, runner_id, source, environment, status, accepted, decided_at,
        checks, artifacts, reasons, artifact_availability, submission_sha256)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'acme/repo','run-1','runner-1','external_runner','ci','accepted',true,now(),
        '[]'::jsonb,$9::text::jsonb,'[]'::jsonb,'[]'::jsonb,$10)`,
    [id, org, proj, req, task, 'idem-' + id.slice(0, 8), 'attempt-' + id.slice(0, 8), SHA,
      JSON.stringify(storageKeys.map((k) => ({ path: 'p/' + k, sha256: 'f'.repeat(64), sizeBytes: 1, storageKey: k }))),
      'e'.repeat(64)]);
  return id;
}

describe.skipIf(!enabled)('PR-7 retention lifecycle (real Postgres)', () => {
  beforeAll(async () => {
    owner = postgres(DB_URL, { max: 2, onnotice: () => {} });
    retention = postgres(asRole('verification_retention_agent', RETENTION_PW), { max: 1, onnotice: () => {} });
    app = postgres(asRole('app_server', APP_PW), { max: 1, onnotice: () => {} });
    await owner.unsafe(`insert into organizations (id, name, slug) values ($1,'PR7','pr7-${org.slice(0, 8)}')`, [org]);
    await owner.unsafe(`insert into profiles (id, email, display_name) values ($1,'pr7-${prof.slice(0, 8)}@example.test','PR7')`, [prof]);
    await owner.unsafe(`insert into projects (id, org_id, key, name) values ($1,$2,'pr7-${proj.slice(0, 8)}','PR7')`, [proj, org]);
    await owner.unsafe(
      `insert into tasks (id, org_id, project_id, title, status, created_by, input, provider_selection)
       values ($1,$2,$3,'t','pending',$4,'{}',
         (select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='provider_selection' order by e.enumsortorder limit 1)::provider_selection)`,
      [task, org, proj, prof]);
    await owner.unsafe(
      `insert into verification_requests (id, org_id, project_id, task_id, repo_full_name, expected_commit_sha, required_checks)
       values ($1,$2,$3,$4,'acme/repo',$5,'[]'::jsonb)`, [req, org, proj, task, SHA]);
  });

  afterAll(async () => {
    await owner?.unsafe(`delete from verification_purge_job_objects where org_id=$1`, [org]).catch(() => {});
    await owner?.unsafe(`delete from verification_purge_jobs where org_id=$1`, [org]).catch(() => {});
    await Promise.all([owner?.end(), retention?.end(), app?.end()]);
  });

  it('the retention role exists and is NOT a superuser and does NOT bypass RLS', async () => {
    const r = await owner.unsafe(`select rolsuper, rolbypassrls from pg_roles where rolname='verification_retention_agent'`);
    expect(r[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('app_server holds neither DELETE on evidence nor EXECUTE on the purge function', async () => {
    const r = await owner.unsafe(`select
        has_table_privilege('app_server','verification_evidence','delete') as del,
        has_function_privilege('app_server','app.purge_verification_evidence(uuid[],text)','execute') as exec`);
    expect(r[0]).toMatchObject({ del: false, exec: false });
  });

  it('app_server DELETE on verification_evidence is REFUSED (PR-1 survives PR-7)', async () => {
    const ev = await seedEvidence(['obj/guard']);
    await expect(app.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      await tx.unsafe(`delete from verification_evidence where id=$1`, [ev]);
    })).rejects.toThrow();
    const left = await owner.unsafe(`select count(*)::int as n from verification_evidence where id=$1`, [ev]);
    expect(left[0]!.n).toBe(1); // still there
  });

  it('UPDATE on evidence is refused even for the table OWNER', async () => {
    await expect(owner.unsafe(`update verification_evidence set status='tampered' where org_id=$1`, [org]))
      .rejects.toThrow(/append-only|UPDATE blocked/i);
  });

  it('a purge records every distinct key and removes the references in one step', async () => {
    const a = await seedEvidence(['obj/a', 'obj/b']);
    const b = await seedEvidence(['obj/b', 'obj/c']); // 'obj/b' shared on purpose
    const jobId = await retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      const r = await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'erasure_request') as job_id`, [[a, b]]);
      return String(r[0]!.job_id);
    });

    const left = await owner.unsafe(`select count(*)::int as n from verification_evidence where id = any($1::uuid[])`, [[a, b]]);
    expect(left[0]!.n).toBe(0);

    const objs = await owner.unsafe(`select object_key, version_id, state from verification_purge_job_objects where job_id=$1 order by object_key`, [jobId]);
    expect(objs.map((o) => o.object_key)).toEqual(['obj/a', 'obj/b', 'obj/c']);
    expect(objs.every((o) => o.version_id === null)).toBe(true); // no pinned versions exist yet

    const job = await owner.unsafe(`select status, object_count::int as oc, reason, requested_by from verification_purge_jobs where id=$1`, [jobId]);
    expect(job[0]).toMatchObject({ status: 'open', oc: 3, reason: 'erasure_request', requested_by: prof });
  });

  it('a failure leaves the object pending and the job open; the last confirmation completes it', async () => {
    const ev = await seedEvidence(['obj/x', 'obj/y']);
    const jobId = await retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      const r = await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'retention_expiry') as job_id`, [[ev]]);
      return String(r[0]!.job_id);
    });
    const ids = (await owner.unsafe(`select id from verification_purge_job_objects where job_id=$1 order by object_key`, [jobId])).map((r) => String(r.id));

    await retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      await tx.unsafe(`select app.record_verification_purge_object_failure($1, 'transient 503')`, [ids[0]!]);
    });
    const failed = await owner.unsafe(`select state, attempts::int as attempts, last_error from verification_purge_job_objects where id=$1`, [ids[0]!]);
    expect(failed[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: 'transient 503' });
    expect((await owner.unsafe(`select status from verification_purge_jobs where id=$1`, [jobId]))[0]!.status).toBe('open');

    for (let i = 0; i < ids.length; i++) {
      const applied = await retention.begin(async (tx) => {
        await tenant(tx as unknown as Sql);
        return (await tx.unsafe(`select app.record_verification_purge_object_deleted($1) as applied`, [ids[i]!]))[0]!.applied;
      });
      expect(applied).toBe(true);
      const status = (await owner.unsafe(`select status from verification_purge_jobs where id=$1`, [jobId]))[0]!.status;
      expect(status).toBe(i === ids.length - 1 ? 'complete' : 'open');
    }

    // Idempotent: re-confirming is a no-op, not a double count.
    const again = await retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      return (await tx.unsafe(`select app.record_verification_purge_object_deleted($1) as applied`, [ids[0]!]))[0]!.applied;
    });
    expect(again).toBe(false);
  });

  it('refuses an invalid reason', async () => {
    const ev = await seedEvidence(['obj/z']);
    await expect(retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'nope')`, [[ev]]);
    })).rejects.toThrow(/retention_expiry or erasure_request/);
  });

  it('a malformed artifacts payload contributes no keys instead of aborting the purge', async () => {
    const bad = randomUUID();
    // artifacts stored as a jsonb STRING rather than an array — jsonb_to_recordset would raise without
    // the jsonb_typeof guard, taking the whole purge down with it.
    await owner.unsafe(
      `insert into verification_evidence
         (id, org_id, project_id, request_id, task_id, idempotency_key, attempt_id, commit_sha, repo_full_name,
          run_id, runner_id, source, environment, status, accepted, decided_at,
          checks, artifacts, reasons, artifact_availability, submission_sha256)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'acme/repo','run-1','runner-1','external_runner','ci','accepted',true,now(),
          '[]'::jsonb,'"not-an-array"'::jsonb,'[]'::jsonb,'[]'::jsonb,$9)`,
      [bad, org, proj, req, task, 'idem-' + bad.slice(0, 8), 'attempt-' + bad.slice(0, 8), SHA, 'e'.repeat(64)]);

    const jobId = await retention.begin(async (tx) => {
      await tenant(tx as unknown as Sql);
      const r = await tx.unsafe(`select app.purge_verification_evidence($1::uuid[], 'retention_expiry') as job_id`, [[bad]]);
      return String(r[0]!.job_id);
    });
    const job = await owner.unsafe(`select status, object_count::int as oc from verification_purge_jobs where id=$1`, [jobId]);
    expect(job[0]).toMatchObject({ oc: 0, status: 'complete' }); // nothing to confirm gone
    expect((await owner.unsafe(`select count(*)::int as n from verification_evidence where id=$1`, [bad]))[0]!.n).toBe(0);
  });
});
