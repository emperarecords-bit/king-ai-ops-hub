import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError, ValidationError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, knowledgeDisclosureGrants, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { createKnowledge, selectRelevantKnowledge } from '@/domain/knowledge/knowledge';
import { createDisclosureGrant, listDisclosureGrants, revokeDisclosureGrant } from '@/domain/knowledge/disclosure';

/**
 * ENFORCEABLE DISCLOSURE GRANTS — the only path by which `restricted` Knowledge reaches a prompt.
 * A grant is scoped per SPECIFIC agent + SPECIFIC purpose inside an explicit window; it must be live
 * (not revoked, not expired) to disclose; a run discloses a restricted item only when EVERY consuming
 * agent is granted; and a supplied disclosure records the authorizing grant id(s) in its snapshot.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[knowledge-disclosure.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';
let agentA = '';
let agentB = '';

async function mkAgent(name: string): Promise<string> {
  const r = await getSetupDb()
    .insert(agents)
    .values({ orgId, projectId: ctx.projectId, name: `${name}-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' })
    .returning({ id: agents.id });
  return r[0]!.id;
}

/** A relevant, ACTIVE, restricted item with distinctive vocabulary + its matching query. */
async function restrictedItem(token: string): Promise<{ id: string; query: string }> {
  const id = await withTenant(ctx, (tx) =>
    createKnowledge(tx, ctx, { title: `${token} directive`, body: `${token} directive for privileged ${token} operations.`, kind: 'fact', disclosure: 'restricted', activate: true }),
  );
  return { id, query: `${token} directive privileged operations` };
}

const future = () => new Date(Date.now() + 86_400_000);

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.insert(profiles).values({ id: userId, email: `disc-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Disc Tester' });
  const org = await db.insert(organizations).values({ name: 'Disc Org', slug: `disc-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('disc'), name: 'Disc Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  agentA = await mkAgent('A');
  agentB = await mkAgent('B');
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('enforceable disclosure grants', () => {
  it('a restricted item is withheld from a consuming agent when no grant exists', async () => {
    const { id, query } = await restrictedItem('zenith');
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA] }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('a live grant for the specific agent + purpose discloses it, and the snapshot records the grant id', async () => {
    const { id, query } = await restrictedItem('cavern');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future(), rationale: 'agent A runs the privileged flow' }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA], intendedUse: 'current_operational_fact' }));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.trustSnapshot.disclosureGrantIds).toEqual([grantId]);
  });

  it('a grant for a different PURPOSE does not disclose (purpose is part of the grant)', async () => {
    const { id, query } = await restrictedItem('lantern');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'historical_analysis', expiresAt: future() }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA], intendedUse: 'current_operational_fact' }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('every consuming agent must be granted — a grant to only one of two withholds the whole disclosure', async () => {
    const { id, query } = await restrictedItem('summit');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Run consumes context for BOTH agents; only A is granted.
    let picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA, agentB] }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
    // Grant B too → both consuming agents authorized → disclosed, with both grant ids.
    const gB = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentB, purpose: 'current_operational_fact', expiresAt: future() }));
    picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA, agentB] }));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.trustSnapshot.disclosureGrantIds).toHaveLength(2);
    expect(hit!.trustSnapshot.disclosureGrantIds).toContain(gB);
  });

  it('an expired grant is no grant', async () => {
    const { id, query } = await restrictedItem('harbor');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Push the expiry into the past (the create guard forbids a past expiry; the selector still must reject it).
    await getSetupDb().update(knowledgeDisclosureGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(knowledgeDisclosureGrants.id, grantId));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA] }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('a revoked grant is no grant, revocation is recorded, and double-revoke conflicts', async () => {
    const { id, query } = await restrictedItem('meadow');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Present before revocation.
    let picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA] }));
    expect(picked.find((k) => k.id === id)).toBeDefined();
    // Revoke → withheld.
    await withTenant(ctx, (tx) => revokeDisclosureGrant(tx, ctx, grantId, 'no longer needed'));
    picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [agentA] }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
    // The grant row and its revocation survive (a decision with history, not a delete).
    const grants = await withTenant(ctx, (tx) => listDisclosureGrants(tx, ctx, id));
    expect(grants[0]!.revokedAt).not.toBeNull();
    expect(grants[0]!.revokeReason).toBe('no longer needed');
    // Revoking again conflicts.
    await expect(withTenant(ctx, (tx) => revokeDisclosureGrant(tx, ctx, grantId))).rejects.toThrow(ConflictError);
  });

  it('only restricted Knowledge accepts a grant', async () => {
    const openId = await withTenant(ctx, (tx) => createKnowledge(tx, ctx, { title: 'Open note', body: 'b', kind: 'fact', activate: true }));
    await expect(
      withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: openId, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() })),
    ).rejects.toThrow(ValidationError);
  });

  it('a non-run consumer (no consuming agent) can never receive restricted Knowledge, even with a grant present', async () => {
    const { id, query } = await restrictedItem('cinder');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Empty consumer set (e.g. objective suggestion) → no agent to authorize → withheld.
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerAgentIds: [] }));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });
});
