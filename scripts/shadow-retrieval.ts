import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { documentChunks, documentVersions, documents, projectMembers, projects } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { TenantContext } from '../src/types/domain';
import { runShadowCorpus } from '../src/domain/documents/shadow';

/**
 * Documents increment 1, Stage C2 — shadow retrieval acceptance run.
 *
 * Runs legacy vs versioned retrieval over a corpus for each workspace and reports the difference
 * classification. Read-only: writes no evidence and mutates nothing. The corpus exercises EVERY currently
 * retrievable Document (a query built from its current version's salient tokens) plus generic / multi-term
 * / no-result probes, so all retrievable sources are represented and every unavailable source is listed as
 * an expected exclusion.
 *
 *   SHADOW_ONLY_PROJECT=<projectId>  restrict to one workspace (optional).
 */

const GENERIC_QUERIES = ['status', 'the project plan and timeline', 'pricing and cost per seat', 'zxqwv nonexistent frobnicate token', 'review episode continuity', 'production status update'];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'will', 'their', 'which', 'about', 'into', 'your', 'you', 'our', 'has', 'have', 'not', 'but', 'they', 'them', 'his', 'her', 'its']);

function tokensFrom(text: string, n = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 5 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= n) break;
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));

  const onlyProject = process.env.SHADOW_ONLY_PROJECT ?? null;
  const allProjects = await db.select({ id: projects.id, orgId: projects.orgId, key: projects.key }).from(projects);
  const targets = (onlyProject ? allProjects.filter((p) => p.id === onlyProject) : allProjects);

  let anyBlocking = false;
  for (const p of targets) {
    const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, p.id)).limit(1))[0];
    const ctx: TenantContext = { userId: member?.userId ?? '00000000-0000-0000-0000-000000000000', orgId: p.orgId, projectId: p.id, orgRole: 'owner', projectRole: 'admin' };

    // Build the corpus: one query per retrievable Document (from its current version's first chunk) + generics.
    const retrievableChunks = await db
      .select({ relativePath: documents.relativePath, content: documentChunks.content })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.status, 'active'), eq(documentVersions.indexStatus, 'indexed'), eq(documentChunks.documentVersionId, documents.currentVersionId), eq(documentChunks.chunkIndex, 0)));
    if (retrievableChunks.length === 0 && targets.length > 1) continue; // skip empty workspaces in the global sweep

    const perDoc = retrievableChunks.map((c) => tokensFrom(c.content).join(' ')).filter((q) => q.length > 0);
    const corpus = [...new Set([...perDoc, ...GENERIC_QUERIES])];

    const report = await tx((t) => runShadowCorpus(t, ctx, corpus, 5));
    if (report.blockingDifferences.length > 0) anyBlocking = true;
    console.log(`\n=== shadow[${p.key}] ===`);
    console.log(JSON.stringify({
      queries: report.queries,
      comparedPositions: report.comparedPositions,
      legacyResultPositions: report.legacyResultPositions,
      versionedResultPositions: report.versionedResultPositions,
      exactMatches: report.exactMatches,
      byCategory: report.byCategory,
      retrievableDocuments: report.retrievableDocuments,
      expectedNonRetrievable: report.expectedNonRetrievable,
      timing: report.timing,
      shadowErrors: report.shadowErrors,
      blockingDifferences: report.blockingDifferences,
      switchClear: report.switchClear,
    }, null, 2));
  }

  console.log(`\nshadow sweep complete — ${anyBlocking ? 'BLOCKING DIFFERENCES PRESENT' : 'no blocking differences'}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
