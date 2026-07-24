import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { chunkText, linkFolder, refreshIndex, retrieveRelevant } from '@/domain/documents/documents';

/**
 * Project Folder ingestion + retrieval (D-020). The test that matters most is
 * the last one: a query in workspace A cannot retrieve a document indexed in
 * workspace B — retrieval feeds prompts, so a leak here is the I1 violation the
 * whole product exists to prevent.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[documents.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

let orgId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;
let folderA = '';
let folderB = '';

async function makeWorkspace(userId: string): Promise<TenantContext> {
  const db = getDb();
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('docs'), name: 'Docs Project' })
    .returning({ id: projects.id });
  const projectId = project[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId, role: 'admin' });
  return { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
}

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  const userId = randomUUID();
  await db
    .insert(profiles)
    .values({ id: userId, email: `docs-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db
    .insert(organizations)
    .values({ name: 'Docs Org', slug: `docs-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });

  ctxA = await makeWorkspace(userId);
  ctxB = await makeWorkspace(userId);

  folderA = await mkdtemp(join(tmpdir(), 'kaoh-docs-a-'));
  folderB = await mkdtemp(join(tmpdir(), 'kaoh-docs-b-'));
  // Workspace A knows about the pricing model. B knows about kubernetes.
  await writeFile(
    join(folderA, 'pricing.md'),
    '# Pricing\n\nOur pricing model uses tiered subscriptions. The enterprise tier costs 500 dollars per seat.\n\nDiscounts apply for annual billing.',
  );
  await writeFile(
    join(folderA, 'notes.txt'),
    'Miscellaneous notes about the office coffee machine.',
  );
  await writeFile(
    join(folderB, 'infra.md'),
    '# Infrastructure\n\nDeployment runs on kubernetes with three replicas behind a load balancer.',
  );
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
  if (folderA) await rm(folderA, { recursive: true, force: true });
  if (folderB) await rm(folderB, { recursive: true, force: true });
});

describe('chunkText (pure)', () => {
  it('splits on blank lines and drops empties', () => {
    expect(chunkText('a\n\n\nb\n\n')).toEqual(['a\n\nb']);
    expect(chunkText('   ')).toEqual([]);
  });
});

describe.skipIf(!available)('project folder', () => {
  it('indexes supported files and skips unchanged on re-refresh', async () => {
    await withTenant(ctxA, (tx) => linkFolder(tx, ctxA, folderA));
    const first = await withTenant(ctxA, (tx) => refreshIndex(tx, ctxA));
    expect(first.indexed).toBe(2); // pricing.md + notes.txt

    const second = await withTenant(ctxA, (tx) => refreshIndex(tx, ctxA));
    expect(second.indexed).toBe(0);
    expect(second.skippedUnchanged).toBe(2);
  });

  it('retrieves the relevant document and ranks it above the irrelevant one', async () => {
    const hits = await withTenant(ctxA, (tx) =>
      retrieveRelevant(tx, ctxA, 'what is our enterprise pricing per seat?', 5),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.relativePath).toBe('pricing.md');
    // The coffee note should not outrank pricing for a pricing query.
    expect(hits.every((h) => h.rank >= (hits[hits.length - 1]?.rank ?? 0))).toBe(true);
  });

  it('a nonsense query returns nothing rather than everything', async () => {
    const hits = await withTenant(ctxA, (tx) =>
      retrieveRelevant(tx, ctxA, 'zxqw plumbus frobnicate', 5),
    );
    expect(hits).toEqual([]);
  });

  it('ISOLATION: workspace B cannot retrieve workspace A documents', async () => {
    await withTenant(ctxB, (tx) => linkFolder(tx, ctxB, folderB));
    await withTenant(ctxB, (tx) => refreshIndex(tx, ctxB));

    // The exact query that hits pricing.md in A must return nothing in B.
    const crossHits = await withTenant(ctxB, (tx) =>
      retrieveRelevant(tx, ctxB, 'what is our enterprise pricing per seat?', 5),
    );
    expect(crossHits.every((h) => h.relativePath !== 'pricing.md')).toBe(true);

    // And B's own content is reachable from B, proving the query itself works.
    const ownHits = await withTenant(ctxB, (tx) =>
      retrieveRelevant(tx, ctxB, 'kubernetes deployment replicas', 5),
    );
    expect(ownHits[0]?.relativePath).toBe('infra.md');
  });
});
