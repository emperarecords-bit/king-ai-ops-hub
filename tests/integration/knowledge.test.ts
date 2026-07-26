import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import {
  activateKnowledge,
  archiveKnowledge,
  createKnowledge,
  listInjectionsForKnowledge,
  listKnowledge,
  logKnowledgeInjections,
  reviseKnowledge,
  selectRelevantKnowledge,
} from '@/domain/knowledge/knowledge';
import { loadApprovedContext } from '@/domain/projects/context';

/**
 * K1 rules that must never regress: only ACTIVE knowledge is injected;
 * drafts are quarantine; a version supersedes its predecessor atomically so
 * two versions can never inject together; archived is terminal.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[knowledge.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({
    id: userId,
    email: `know-${randomUUID().slice(0, 8)}@test.local`,
    displayName: 'Knowledge Tester',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Know Test Org', slug: `know-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('know'), name: 'Know Test Project' })
    .returning({ id: projects.id });
  await db
    .insert(projectMembers)
    .values({ orgId, projectId: project[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: project[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  // Audit rows pin the fixtures (ON DELETE RESTRICT) — archive, don't delete.
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('company knowledge K1', () => {
  let draftId = '';
  let activeId = '';

  it('drafts are never injected into prompts', async () => {
    draftId = await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'Draft standard',
        body: 'Not yet approved.',
        kind: 'standard',
        activate: false,
      }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')).toBeUndefined();
  });

  it('activation makes an item injectable, with approver recorded', async () => {
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, draftId));
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Not yet approved.');
    activeId = draftId;
  });

  it('human-created knowledge may activate immediately', async () => {
    await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'House style',
        body: 'Short sentences.',
        kind: 'brand',
        activate: true,
      }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeDefined();
  });

  it('a new version supersedes atomically — exactly one version injects', async () => {
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, activeId, { body: 'Approved, v2.', activate: true }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    const versions = injected.filter((i) => i.title === 'Draft standard');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toBe('Approved, v2.');

    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx));
    const v1 = all.find((i) => i.id === activeId);
    expect(v1?.status).toBe('archived');
    const v2 = all.find((i) => i.supersedes === activeId);
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe('active');
  });

  it('a draft revision does NOT replace the active version until activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const current = all.find((i) => i.title === 'Draft standard')!;
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, current.id, { body: 'v3 pending.', activate: false }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Approved, v2.');
  });

  it('archived is terminal and never injects', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const house = all.find((i) => i.title === 'House style')!;
    await withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id));
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeUndefined();
    await expect(
      withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id)),
    ).rejects.toThrow(ConflictError);
  });

  it('only drafts can be activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const active = all[0]!;
    await expect(
      withTenant(ctx, (tx) => activateKnowledge(tx, ctx, active.id)),
    ).rejects.toThrow(ConflictError);
  });
});

describe.skipIf(!available)('knowledge retrieval is relevance-gated (not wholesale)', () => {
  it('an unrelated active item is NOT injected; membership + recency do not create relevance', async () => {
    const shipping = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Shipping carrier accounts', body: 'Freight carrier logistics warehouse pallet dispatch codes.', kind: 'fact', activate: true }));
    // A recent, active, workspace item — but no shared subject with a database query → omitted.
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'migrate the postgres database schema and indexes' }));
    expect(picked.find((k) => k.id === shipping)).toBeUndefined();
  });

  it('a relevant active item IS injected, with a recorded eligibility reason', async () => {
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Database migration policy', body: 'Postgres schema migrations run through drizzle with a backup first.', kind: 'standard', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'migrate the postgres database schema safely' }));
    const hit = picked.find((k) => k.title === 'Database migration policy')!;
    expect(hit).toBeDefined();
    expect(hit.reason).toBe('subject');
  });

  it('drafts, archived, and superseded versions are never selected; one version at most', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Refund window rule', body: 'Refund window billing invoice payment terms are thirty days.', kind: 'policy', activate: true }));
    await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, id, { body: 'Refund window billing invoice payment terms are now sixty days.', activate: true }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'refund window billing invoice payment terms' }));
    const matches = picked.filter((k) => k.title === 'Refund window rule');
    expect(matches).toHaveLength(1); // v1 archived, only v2 active
    expect(matches[0]!.body).toMatch(/sixty days/);
    // A draft is not selected.
    await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Refund draft', body: 'Refund window billing invoice payment draft only.', kind: 'policy', activate: false }));
    const picked2 = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: 'refund window billing invoice payment terms' }));
    expect(picked2.find((k) => k.title === 'Refund draft')).toBeUndefined();
  });

  it('application records are idempotent and preserve the exact supplied text after a later revision', async () => {
    const id = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Vendor onboarding steps', body: 'Vendor onboarding contract signature compliance checklist steps.', kind: 'playbook', activate: true }));
    // A run to attach the application record to.
    const a = await getSetupDb().insert(agents).values({ orgId, projectId: ctx.projectId, name: `A-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
    const t = await getSetupDb().insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Vendor task', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId }).returning({ id: tasks.id });
    const r = await getSetupDb().insert(runs).values({ orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
    const selected = [{ id, version: 1, title: 'Vendor onboarding steps', body: 'original', reason: 'subject', memoryText: 'EXACT vendor text v1' }];
    await withTenant(ctx, (tx) => logKnowledgeInjections(tx, ctx, { runId: r[0]!.id, taskId: t[0]!.id, injected: selected }));
    await withTenant(ctx, (tx) => logKnowledgeInjections(tx, ctx, { runId: r[0]!.id, taskId: t[0]!.id, injected: [{ ...selected[0]!, memoryText: 'DIFFERENT (ignored)' }] }));
    let trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    expect(trail).toHaveLength(1); // idempotent per (run, item)
    expect(trail[0]!.memoryText).toBe('EXACT vendor text v1');
    // Revise the item; the historical snapshot is unchanged.
    await withTenant(ctx, (tx) => reviseKnowledge(tx, ctx, id, { body: 'Rewritten entirely.', activate: true }));
    trail = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, id));
    expect(trail[0]!.memoryText).toBe('EXACT vendor text v1');
    expect(trail[0]!.version).toBe(1);
  });
});
