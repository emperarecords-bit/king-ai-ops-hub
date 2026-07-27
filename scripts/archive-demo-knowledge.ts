import 'dotenv/config';
import { and, eq, like, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { knowledgeItems, projects } from '../src/db/schema';

/**
 * Archives the visual-acceptance demo records — every `[demo]` Knowledge item in a project is set to
 * `archived` (the correct cleanup: append-only verification/lifecycle history is preserved, never
 * erased). Idempotent. Uses the migration-role connection (deploy/admin context).
 *
 *   SEED_PROJECT_KEY=<key> npm run archive:demo-knowledge
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  const projectKey = process.env.SEED_PROJECT_KEY ?? 'king-ai-ops-hub';
  const project = (await db.select().from(projects).where(eq(projects.key, projectKey)).limit(1))[0];
  if (!project) throw new Error(`Project '${projectKey}' not found.`);

  const archived = await db
    .update(knowledgeItems)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(knowledgeItems.projectId, project.id), eq(knowledgeItems.orgId, project.orgId), like(knowledgeItems.title, '[demo]%'), ne(knowledgeItems.status, 'archived')))
    .returning({ id: knowledgeItems.id });

  console.log(`Archived ${archived.length} [demo] Knowledge record(s) in '${projectKey}'. Verification and lifecycle history are preserved.`);
  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
