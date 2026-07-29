import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, organizations, profiles, projectMembers, projects, runs, runDocumentVersions, tasks } from '@/db/schema';
import { writeRunVersionEvidence } from '@/domain/documents/references';

/**
 * Documents increment 1, Stage C2 closure (Blocker 2) — evidence-before-dispatch boundary.
 *
 * The runner's preflight is ONE transaction: freeze context → insert run → snapshot → normalized
 * references → COMMIT. Provider dispatch (executeRun) runs only AFTER that transaction returns. This test
 * models that structure and proves the invariant: if the normalized-reference insertion fails, the run
 * transaction rolls back (no durable run) AND the post-commit dispatch step is never reached — a provider
 * never receives Document text before the corresponding durable evidence relationship is committed.
 *
 * Principle: evidence supplied for an attempted operation remains inspectable even when provider execution
 * fails, but the system must never imply successful use.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-evidence-boundary.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let ctx: TenantContext;
let agentId = '';
let taskId = '';
const db = () => getSetupDb();

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `eb-${randomUUID().slice(0, 8)}@t.local`, displayName: 'EB' });
  const org = await db().insert(organizations).values({ name: 'EB Org', slug: `eb-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db().insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('eb'), name: 'EB WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const a = await db().insert(agents).values({ orgId, projectId: p[0]!.id, name: 'primary', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  agentId = a[0]!.id;
  const t = await db().insert(tasks).values({ orgId, projectId: p[0]!.id, title: 'eb task', input: 'x', providerSelection: 'openai', status: 'pending', createdBy: userId }).returning({ id: tasks.id });
  taskId = t[0]!.id;
});

afterAll(async () => {
  if (available && orgId) {
    await db().execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db().execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db().execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db().delete(organizations).where(eq(organizations.id, orgId));
  }
});

describe.skipIf(!available)('Stage C2 — evidence commits before dispatch', () => {
  it('a failing normalized-reference insertion rolls back the run and provider dispatch never occurs', async () => {
    let dispatched = false;

    // Model the runner: preflight (run + snapshot + normalized refs) in ONE transaction, THEN dispatch.
    const runOne = async () =>
      withTenant(ctx, async (tx) => {
        const run = (await tx.insert(runs).values({ classification: 'live', orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'running', primaryAgentId: agentId, retrievedSources: [{ relativePath: 'd.md', sha256: 'h', disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'x', documentVersionId: randomUUID() }] }).returning({ id: runs.id }))[0]!;
        // Normalized-reference insertion fails: the documentVersionId does not exist (FK restrict), so the
        // whole preflight transaction aborts before any provider dispatch.
        await writeRunVersionEvidence(tx, ctx, run.id, [{ documentVersionId: randomUUID(), chunkIndex: 0, rank: null, disclosure: 'workspace_internal' }]);
        return run.id;
      }).then((runId) => {
        // This line stands in for the post-commit `executeRun(...)` dispatch. It is only reached if the
        // preflight transaction COMMITTED.
        dispatched = true;
        return runId;
      });

    await expect(runOne()).rejects.toThrow();

    // Dispatch never occurred.
    expect(dispatched).toBe(false);
    // The run transaction rolled back: no durable run, no orphaned evidence.
    const runRows = await db().select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
    expect(runRows.length).toBe(0);
    const refRows = await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.projectId, ctx.projectId));
    expect(refRows.length).toBe(0);
  });

  it('when evidence commits, the run + normalized references are durable together before any dispatch', async () => {
    // Positive control: a valid evidence write commits atomically with the run; the dispatch step then runs
    // against already-durable evidence. (Uses a real version via a minimal doc.)
    // Insert a real document + indexed version so the evidence FK is satisfiable.
    const doc = (await db().execute(sql`insert into documents (org_id, project_id, source, relative_path, kind, sha256, size_bytes, status) values (${ctx.orgId}, ${ctx.projectId}, 'local_folder', 'ev.md', 'markdown', 'h2', 1, 'active') returning id`)) as unknown as { id: string }[];
    const documentId = doc[0]!.id;
    const ver = (await db().execute(sql`insert into document_versions (org_id, project_id, document_id, sha256, size_bytes, content_fidelity, index_status, parser_version) values (${ctx.orgId}, ${ctx.projectId}, ${documentId}, 'h2', 1, 'reconstructed_text', 'indexed', 'chunk-v1') returning id`)) as unknown as { id: string }[];
    const versionId = ver[0]!.id;

    let dispatched = false;
    const runId = await withTenant(ctx, async (tx) => {
      const run = (await tx.insert(runs).values({ classification: 'live', orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'running', primaryAgentId: agentId }).returning({ id: runs.id }))[0]!;
      await writeRunVersionEvidence(tx, ctx, run.id, [{ documentVersionId: versionId, chunkIndex: 0, rank: null, disclosure: 'workspace_internal' }]);
      return run.id;
    }).then((id) => {
      dispatched = true; // post-commit dispatch
      return id;
    });

    expect(dispatched).toBe(true);
    // Evidence is durable (committed with the run, before the dispatch step ran).
    const refs = await db().select({ chunk: runDocumentVersions.chunkIndex }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, runId));
    expect(refs.map((r) => r.chunk).sort((a, b) => a - b)).toEqual([-1, 0]);
    // cleanup
    await db().delete(runs).where(eq(runs.id, runId));
  });
});
