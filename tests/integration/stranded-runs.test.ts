import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, rlsAvailable } from '@tests/support/db';
import * as schema from '@/db/schema';
import { type DbTx } from '@/db/client';
import { writeAudit } from '@/domain/audit/audit';
import { closeStrandedRun, findStrandedRuns, strandedCutoff, type StrandedRun } from '@/domain/tasks/stranded-runs';

/**
 * Stranded-run repair against a real DB (owner connection, as the repair script runs). Mirrors Hub prod
 * 2026-10-24: runs whose finalization was audited complete but whose row stayed 'running' / 'finalizing'.
 * Only runs meeting EVERY condition are closed; a run that no longer qualifies is skipped; a cancelled task is left
 * alone; a second pass finds nothing.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('stranded-runs.test');

const ids = {
  user: randomUUID(),
  org: randomUUID(),
  project: randomUUID(),
  agent: randomUUID(),
};
const DAY = 86_400_000;
const now = new Date();
const old = new Date(now.getTime() - 30 * DAY);
let admin: postgres.Sql;
let tx: <T>(fn: (t: DbTx) => Promise<T>) => Promise<T>;

interface Case { task: string; run: string }
const cases: Record<'stranded' | 'strandedCancelled' | 'tooNew' | 'liveJob' | 'hasLaterRun' | 'noFinalizationAudit', Case> = {
  stranded: { task: randomUUID(), run: randomUUID() },
  strandedCancelled: { task: randomUUID(), run: randomUUID() },
  tooNew: { task: randomUUID(), run: randomUUID() },
  liveJob: { task: randomUUID(), run: randomUUID() },
  hasLaterRun: { task: randomUUID(), run: randomUUID() },
  noFinalizationAudit: { task: randomUUID(), run: randomUUID() },
};

async function seedRun(c: Case, opts: { taskStatus: string; startedAt: Date; jobStatus: string; audit: boolean }) {
  await admin`insert into tasks (id, org_id, project_id, title, input, provider_selection, created_by, status)
    values (${c.task}, ${ids.org}, ${ids.project}, 'stranded fixture', 'x', 'anthropic', ${ids.user}, ${opts.taskStatus})`;
  await admin`insert into runs (id, org_id, project_id, task_id, primary_agent_id, classification, status, reliability_state, checkpointed_result, started_at)
    values (${c.run}, ${ids.org}, ${ids.project}, ${c.task}, ${ids.agent}, 'live', 'running', 'finalizing', 'draft answer', ${opts.startedAt.toISOString()})`;
  await admin`insert into run_jobs (org_id, project_id, task_id, status) values (${ids.org}, ${ids.project}, ${c.task}, ${opts.jobStatus})`;
  if (opts.audit) {
    await tx((t) =>
      writeAudit(t, { orgId: ids.org, projectId: ids.project, userId: ids.user }, { action: 'run.finalization_completed', entityType: 'run', entityId: c.run, detail: {} }),
    );
  }
}

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  const db = drizzle(admin, { schema });
  tx = (fn) => db.transaction((t) => fn(t));
  await admin`insert into profiles (id, email, display_name) values (${ids.user}, ${`str-${ids.user.slice(0, 8)}@t.local`}, 'Stranded owner')`;
  await admin`insert into organizations (id, name, slug) values (${ids.org}, 'Stranded Org', ${`str-${ids.org.slice(0, 8)}`})`;
  await admin`insert into memberships (org_id, user_id, role) values (${ids.org}, ${ids.user}, 'owner')`;
  await admin`insert into projects (id, org_id, key, name) values (${ids.project}, ${ids.org}, ${`zz-stranded-${ids.project.slice(0, 8)}`}, 'Stranded')`;
  await admin`insert into agents (id, org_id, project_id, name, provider, model, system_prompt) values (${ids.agent}, ${ids.org}, ${ids.project}, 'Ag', 'anthropic', 'claude-sonnet-5', 'x')`;

  await seedRun(cases.stranded, { taskStatus: 'running', startedAt: old, jobStatus: 'done', audit: true });
  await seedRun(cases.strandedCancelled, { taskStatus: 'cancelled', startedAt: old, jobStatus: 'done', audit: true });
  await seedRun(cases.tooNew, { taskStatus: 'running', startedAt: new Date(now.getTime() - DAY), jobStatus: 'done', audit: true });
  await seedRun(cases.liveJob, { taskStatus: 'running', startedAt: old, jobStatus: 'running', audit: true });
  await seedRun(cases.hasLaterRun, { taskStatus: 'running', startedAt: old, jobStatus: 'done', audit: true });
  await admin`insert into runs (id, org_id, project_id, task_id, primary_agent_id, classification, status, started_at)
    values (${randomUUID()}, ${ids.org}, ${ids.project}, ${cases.hasLaterRun.task}, ${ids.agent}, 'live', 'completed', ${new Date(old.getTime() + DAY).toISOString()})`;
  await seedRun(cases.noFinalizationAudit, { taskStatus: 'running', startedAt: old, jobStatus: 'done', audit: false });
});

afterAll(async () => {
  if (admin && available) {
    await admin`delete from audit_logs where org_id = ${ids.org}`.catch(() => {});
    await admin`delete from run_jobs where org_id = ${ids.org}`;
    await admin`delete from runs where org_id = ${ids.org}`;
    await admin`delete from tasks where org_id = ${ids.org}`;
    await admin`delete from agents where org_id = ${ids.org}`;
    await admin`delete from projects where org_id = ${ids.org}`;
    await admin`delete from memberships where org_id = ${ids.org}`;
    await admin`delete from organizations where id = ${ids.org}`.catch(() => {});
    await admin`delete from profiles where id = ${ids.user}`.catch(() => {});
    await admin.end();
  }
});

const mine = (rs: StrandedRun[]) => rs.filter((r) => r.orgId === ids.org);

describe('stranded runs — narrow selection, honest close, idempotent', () => {
  it.runIf(available)('finds ONLY runs meeting every condition', async () => {
    const found = mine(await tx((t) => findStrandedRuns(t, strandedCutoff(now))));
    expect(found.map((r) => r.runId).sort()).toEqual([cases.stranded.run, cases.strandedCancelled.run].sort());
    expect(found.find((r) => r.runId === cases.stranded.run)).toMatchObject({ taskStatus: 'running', projectKey: expect.stringMatching(/^zz-stranded-/) });
  });

  it.runIf(available)('closes them: run failed with the reason, draft kept, running task failed, cancelled task untouched, audited', async () => {
    const cutoff = strandedCutoff(now);
    const found = mine(await tx((t) => findStrandedRuns(t, cutoff)));
    const outs = [];
    for (const r of found) outs.push(await tx((t) => closeStrandedRun(t, r, { now, cutoff, actorUserId: ids.user })));
    expect(outs.every((o) => o.repaired)).toBe(true);

    const runsAfter = await admin`select id, status, reliability_state, error_message, checkpointed_result, finished_at from runs where id in (${cases.stranded.run}, ${cases.strandedCancelled.run})`;
    for (const r of runsAfter) {
      expect(r).toMatchObject({ status: 'failed', reliability_state: 'failed', checkpointed_result: 'draft answer' });
      expect(r.error_message).toMatch(/finalization was recorded as complete on .* never closed .* Re-run the task/);
      expect(r.finished_at).not.toBeNull();
    }
    const t1 = await admin`select status from tasks where id = ${cases.stranded.task}`;
    const t2 = await admin`select status from tasks where id = ${cases.strandedCancelled.task}`;
    expect(t1[0]!.status).toBe('failed');
    expect(t2[0]!.status).toBe('cancelled');
    const audits = await admin`select entity_id, detail from audit_logs where org_id = ${ids.org} and action = 'run.stranded_closed'`;
    expect(audits.map((a) => a.entity_id).sort()).toEqual([cases.stranded.run, cases.strandedCancelled.run].sort());

    // Everything else is untouched.
    const others = await admin`select status from runs where id in (${cases.tooNew.run}, ${cases.liveJob.run}, ${cases.hasLaterRun.run}, ${cases.noFinalizationAudit.run})`;
    expect(others.every((r) => r.status === 'running')).toBe(true);
  });

  it.runIf(available)('a second pass finds nothing, and a run that does not qualify is skipped, never overwritten', async () => {
    const cutoff = strandedCutoff(now);
    expect(mine(await tx((t) => findStrandedRuns(t, cutoff)))).toEqual([]);
    const fake: StrandedRun = {
      runId: cases.liveJob.run,
      taskId: cases.liveJob.task,
      orgId: ids.org,
      projectId: ids.project,
      projectKey: 'x',
      startedAt: old,
      taskStatus: 'running',
      finalizationAuditedAt: old,
    };
    const out = await tx((t) => closeStrandedRun(t, fake, { now, cutoff, actorUserId: ids.user }));
    expect(out).toEqual({ runId: cases.liveJob.run, repaired: false, skipped: 'no longer stranded' });
    const r = await admin`select status from runs where id = ${cases.liveJob.run}`;
    expect(r[0]!.status).toBe('running');
  });
});
