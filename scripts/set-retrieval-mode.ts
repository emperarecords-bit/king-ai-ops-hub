import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { projectMembers, projects } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import { RETRIEVAL_MODES, type RetrievalMode, type TenantContext } from '../src/types/domain';
import { getRetrievalMode, setRetrievalMode } from '../src/domain/documents/retrieval-mode';

/**
 * Documents increment 1, Stage C2 — operator tool to set a workspace's server-authoritative retrieval
 * mode (legacy | shadow | versioned). Per-workspace rollout; audited via the domain function.
 *
 *   RETRIEVAL_MODE_PROJECT=<projectId | projectKey> RETRIEVAL_MODE=<mode> npm run set:retrieval-mode
 */

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const target = process.env.RETRIEVAL_MODE_PROJECT;
  const mode = process.env.RETRIEVAL_MODE as RetrievalMode | undefined;
  if (!target || !mode || !RETRIEVAL_MODES.includes(mode)) {
    console.error(`Usage: RETRIEVAL_MODE_PROJECT=<id|key> RETRIEVAL_MODE=<${RETRIEVAL_MODES.join('|')}> npm run set:retrieval-mode`);
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));

  const project = (await db.select().from(projects).where(eq(projects.id, target)).limit(1))[0]
    ?? (await db.select().from(projects).where(eq(projects.key, target)).limit(1))[0];
  if (!project) {
    console.error(`Project '${target}' not found.`);
    await sql.end();
    process.exit(1);
  }
  const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1))[0];
  const ctx: TenantContext = { userId: member?.userId ?? '00000000-0000-0000-0000-000000000000', orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  const before = await tx((t) => getRetrievalMode(t, ctx));
  await tx((t) => setRetrievalMode(t, ctx, mode));
  const after = await tx((t) => getRetrievalMode(t, ctx));
  console.log(`[set:retrieval-mode] ${project.key}: ${before} → ${after}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
