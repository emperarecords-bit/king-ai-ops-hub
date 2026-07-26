import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError, ValidationError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, knowledgeDisclosureGrants, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { createKnowledge, selectRelevantKnowledge, type KnowledgeConsumerType } from '@/domain/knowledge/knowledge';
import { createDisclosureGrant, listDisclosureGrants, revokeDisclosureGrant } from '@/domain/knowledge/disclosure';
import { updateAgent } from '@/domain/agents/agents';

/**
 * ENFORCEABLE DISCLOSURE GRANTS — the only path by which `restricted` Knowledge reaches a prompt.
 * A grant is scoped per SPECIFIC agent EXECUTION IDENTITY + SPECIFIC purpose inside an explicit window.
 * It must be live (not revoked, not expired) AND still match the agent's current execution fingerprint;
 * a run discloses a restricted item only when EVERY consuming agent is authorized; the purpose is
 * DERIVED from the operation, never supplied; and a supplied disclosure records the authorizing grant(s)
 * and the exact execution identity that received it.
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
/** A task-run selection consuming context for the given agents. */
const run = (query: string, consumerAgentIds: string[]) => ({ queryText: query, consumerType: 'task_run' as KnowledgeConsumerType, consumerAgentIds });

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
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('a live grant for the specific agent + purpose discloses it, recording the grant and the exact execution identity', async () => {
    const { id, query } = await restrictedItem('cavern');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future(), rationale: 'agent A runs the privileged flow' }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.trustSnapshot.disclosureGrants).toHaveLength(1);
    const g = hit!.trustSnapshot.disclosureGrants[0]!;
    expect(g.grantId).toBe(grantId);
    expect(g.agentId).toBe(agentA);
    expect(g.provider).toBe('openai');
    expect(g.model).toBe('gpt-5.4-mini');
    expect(typeof g.executionFingerprint).toBe('string');
    expect(g.expiresAt).toBeTruthy();
  });

  it('a grant for a different PURPOSE does not disclose (purpose is derived from the operation, not the grant alone)', async () => {
    const { id, query } = await restrictedItem('lantern');
    // Granted for historical_analysis, but a task run derives current_operational_fact → no match.
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'historical_analysis', expiresAt: future() }));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('every consuming agent must be granted — a grant to only one of two withholds the whole disclosure', async () => {
    const { id, query } = await restrictedItem('summit');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    let picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA, agentB])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
    const gB = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentB, purpose: 'current_operational_fact', expiresAt: future() }));
    picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA, agentB])));
    const hit = picked.find((k) => k.id === id);
    expect(hit).toBeDefined();
    expect(hit!.trustSnapshot.disclosureGrants.map((g) => g.grantId)).toContain(gB);
    expect(hit!.trustSnapshot.disclosureGrants).toHaveLength(2);
  });

  it('an expired grant is no grant', async () => {
    const { id, query } = await restrictedItem('harbor');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    await getSetupDb().update(knowledgeDisclosureGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(knowledgeDisclosureGrants.id, grantId));
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  it('a revoked grant is no grant, revocation is recorded, and double-revoke conflicts', async () => {
    const { id, query } = await restrictedItem('meadow');
    const grantId = await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    let picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    expect(picked.find((k) => k.id === id)).toBeDefined();
    await withTenant(ctx, (tx) => revokeDisclosureGrant(tx, ctx, grantId, 'no longer needed'));
    picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
    const grants = await withTenant(ctx, (tx) => listDisclosureGrants(tx, ctx, id));
    expect(grants[0]!.revokedAt).not.toBeNull();
    expect(grants[0]!.revokeReason).toBe('no longer needed');
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
    const picked = await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [])));
    expect(picked.find((k) => k.id === id)).toBeUndefined();
  });

  // --- Constraint 1: grants bind to an immutable execution identity ---------------------------------

  it("reconfiguring the agent's model (a material execution change) invalidates the old grant", async () => {
    const { id, query } = await restrictedItem('boulder');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Present while the execution profile matches.
    expect((await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])))).find((k) => k.id === id)).toBeDefined();
    // Change the model → new execution fingerprint → the old grant no longer authorizes.
    await withTenant(ctx, (tx) => updateAgent(tx, ctx, agentA, { model: 'gpt-5.4' }));
    expect((await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])))).find((k) => k.id === id)).toBeUndefined();
    // Restore the model so later tests using agentA keep their fingerprint.
    await withTenant(ctx, (tx) => updateAgent(tx, ctx, agentA, { model: 'gpt-5.4-mini' }));
  });

  it("changing the agent's provider cannot silently preserve disclosure authority", async () => {
    const { id, query } = await restrictedItem('canyon');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentB, purpose: 'current_operational_fact', expiresAt: future() }));
    expect((await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentB])))).find((k) => k.id === id)).toBeDefined();
    // Reconfigure the agent to send context to a different provider (its external data boundary changes).
    await getSetupDb().update(agents).set({ provider: 'anthropic' }).where(eq(agents.id, agentB));
    expect((await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentB])))).find((k) => k.id === id)).toBeUndefined();
    await getSetupDb().update(agents).set({ provider: 'openai' }).where(eq(agents.id, agentB));
  });

  it('a harmless display-name change does NOT invalidate an existing grant', async () => {
    const { id, query } = await restrictedItem('willow');
    await withTenant(ctx, (tx) => createDisclosureGrant(tx, ctx, { knowledgeItemId: id, agentId: agentA, purpose: 'current_operational_fact', expiresAt: future() }));
    // Rename the agent (descriptive only — not part of the execution fingerprint).
    await getSetupDb().update(agents).set({ name: `Renamed-${randomUUID().slice(0, 6)}` }).where(eq(agents.id, agentA));
    const hit = (await withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, run(query, [agentA])))).find((k) => k.id === id);
    expect(hit).toBeDefined(); // authority survives a rename
  });

  // --- Constraint 3: purpose is derived from the operation, never forged ----------------------------

  it('a forged/unsupported consumer type is rejected (purpose cannot be caller-supplied)', async () => {
    const { query } = await restrictedItem('forge');
    await expect(
      withTenant(ctx, (tx) => selectRelevantKnowledge(tx, ctx, { queryText: query, consumerType: 'sneaky_relabel' as unknown as KnowledgeConsumerType, consumerAgentIds: [agentA] })),
    ).rejects.toThrow(ValidationError);
  });
});
