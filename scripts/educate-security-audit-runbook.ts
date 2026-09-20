import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { knowledgeItems, projectMembers, projects } from '../src/db/schema';

/**
 * Pins the reusable "App Security Audit Runbook" (scripts/security-audit-runbook.md)
 * into a workspace's Knowledge as a pinned, active `playbook` — so it is injected into
 * every run of that workspace. Insert-if-absent by (project, title): Knowledge is
 * versioned, so a blind upsert would be wrong — later revisions go through the app's
 * revise flow, never this script. Idempotent; re-running is a no-op.
 *
 * Uses the migration-role connection (deploy/admin context), which bypasses RLS, so no
 * app.project_id GUC is needed. Defaults to the StressProbe QA workspace.
 *
 *   SEED_PROJECT_KEY=stressprobe npm run educate:security-runbook
 */
const TITLE = 'App Security Audit Runbook + AccurateBids Review (2026-09-20)';

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  const here = dirname(fileURLToPath(import.meta.url));
  const body = readFileSync(join(here, 'security-audit-runbook.md'), 'utf8');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  const projectKey = process.env.SEED_PROJECT_KEY ?? 'stressprobe';
  const project = (await db.select().from(projects).where(eq(projects.key, projectKey)).limit(1))[0];
  if (!project) throw new Error(`Project '${projectKey}' not found.`);

  // created_by/approved_by need a real profile id — use a project member (owner/admin).
  const member = (
    await db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1)
  )[0];
  if (!member) throw new Error(`No project member found for '${projectKey}'.`);

  const existing = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.projectId, project.id), eq(knowledgeItems.title, TITLE)))
    .limit(1);
  if (existing.length > 0) {
    console.log(`'${TITLE}' already present in '${projectKey}' (${existing[0].id}); skipping — Knowledge is versioned.`);
    await sql.end();
    process.exit(0);
  }

  const [row] = await db
    .insert(knowledgeItems)
    .values({
      orgId: project.orgId,
      projectId: project.id,
      scope: 'project',
      kind: 'playbook',
      pinned: true, // pinned + workspace scope → injected into every run of this workspace
      title: TITLE,
      body,
      status: 'active', // must be active to inject
      source: 'manual',
      scopeKind: 'workspace',
      disclosure: 'workspace_internal',
      createdBy: member.userId,
      approvedBy: member.userId,
      approvedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });

  console.log(`Pinned '${TITLE}' into '${projectKey}' (${row.id}).`);
  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
