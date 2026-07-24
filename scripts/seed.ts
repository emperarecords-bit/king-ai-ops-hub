import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_STAFF, STAFF_RENAMES } from '../src/domain/projects/default-staff';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';

/**
 * Seeds the owner org and the five isolated workspaces:
 * AccurateBids, KodiScan, BushAndBelly, StressPro, PartsHunt Pro.
 *
 * Idempotent — safe to re-run. Uses the migration connection because it must
 * write across projects; the running app can never do this.
 *
 * The owner profile id: pass SEED_OWNER_ID (the Supabase auth user id) to bind
 * the seed to your real login. Without it, a placeholder id is generated and
 * printed — sign-in will link automatically when the email matches.
 */

/**
 * Workspaces with their approved development budgets (Executive Decisions
 * 2026-07-23, SPRINT-03-PLAN.md §1). Budgets are USD micros ($1 = 1,000,000)
 * and are development-phase values, adjustable later. Re-running the seed
 * APPLIES these budgets (upsert), so this table is authoritative.
 */
const PROJECTS: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  monthlyBudgetMicros: bigint;
}> = [
  {
    key: 'king-ai-ops-hub',
    name: 'King AI Ops Hub',
    description: 'The platform itself — self-development, docs, planning (dogfood workspace).',
    monthlyBudgetMicros: 100_000_000n, // $100
  },
  {
    key: 'accuratebids',
    name: 'AccurateBids',
    description: 'HVAC bidding platform.',
    monthlyBudgetMicros: 100_000_000n, // $100
  },
  {
    key: 'stresspro',
    name: 'StressPro',
    description: 'StressPro product.',
    monthlyBudgetMicros: 40_000_000n, // $40
  },
  {
    key: 'kodiscan',
    name: 'KodiScan',
    description: 'Scanning and analysis product.',
    monthlyBudgetMicros: 30_000_000n, // $30
  },
  {
    key: 'bushandbelly',
    name: 'BushAndBelly',
    description: 'BushAndBelly venture.',
    monthlyBudgetMicros: 30_000_000n, // $30
  },
  {
    key: 'partshunt-pro',
    name: 'PartsHunt Pro',
    description: 'Parts sourcing tool.',
    monthlyBudgetMicros: 30_000_000n, // $30
  },
];

/**
 * Default agents come from the shared roster (business names per P5, standard
 * tier models per D-014). Re-running the seed renames legacy vendor-named
 * agents and resets roster agents' models/prompts; give an agent a custom
 * name to opt it out of seed management.
 */
const DEFAULT_AGENTS = DEFAULT_STAFF;

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? 'owner@example.com';
  const ownerId = process.env.SEED_OWNER_ID ?? randomUUID();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  console.log(`Seeding owner profile ${ownerEmail} (${ownerId})…`);
  await db
    .insert(schema.profiles)
    .values({ id: ownerId, email: ownerEmail, displayName: 'Owner' })
    .onConflictDoNothing({ target: schema.profiles.email });

  const ownerRow = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.email, ownerEmail))
    .limit(1);
  const owner = ownerRow[0];
  if (!owner) throw new Error('Failed to upsert owner profile.');

  console.log('Seeding organization…');
  await db
    .insert(schema.organizations)
    .values({ name: 'King Operations', slug: 'king-operations' })
    .onConflictDoNothing({ target: schema.organizations.slug });
  const org = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, 'king-operations'))
      .limit(1)
  )[0];
  if (!org) throw new Error('Failed to upsert organization.');

  await db
    .insert(schema.memberships)
    .values({ orgId: org.id, userId: owner.id, role: 'owner' })
    .onConflictDoNothing();

  // Departments (D-012/D-015): stable org-level structure of the AI workforce.
  console.log('Seeding departments…');
  const DEPARTMENTS = [
    ['engineering', 'Engineering'],
    ['marketing', 'Marketing'],
    ['finance', 'Finance'],
    ['operations', 'Operations'],
    ['support', 'Support'],
    ['sales', 'Sales'],
    ['legal', 'Legal'],
    ['research', 'Research'],
  ] as const;
  for (const [key, name] of DEPARTMENTS) {
    await db
      .insert(schema.departments)
      .values({ orgId: org.id, key, name })
      .onConflictDoNothing();
  }
  const engineering = (
    await db
      .select()
      .from(schema.departments)
      .where(eq(schema.departments.key, 'engineering'))
      .limit(1)
  )[0];
  if (!engineering) throw new Error('Failed to upsert engineering department.');

  for (const p of PROJECTS) {
    console.log(`Seeding project ${p.name}…`);
    await db
      .insert(schema.projects)
      .values({ orgId: org.id, key: p.key, name: p.name, description: p.description })
      .onConflictDoNothing();
    const project = (
      await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.key, p.key))
        .limit(1)
    )[0];
    if (!project) throw new Error(`Failed to upsert project ${p.key}`);

    await db
      .insert(schema.projectMembers)
      .values({ orgId: org.id, projectId: project.id, userId: owner.id, role: 'admin' })
      .onConflictDoNothing();

    // Approved budgets are authoritative: upsert, don't skip.
    await db
      .insert(schema.spendLimits)
      .values({ orgId: org.id, projectId: project.id, monthlyLimitMicros: p.monthlyBudgetMicros })
      .onConflictDoUpdate({
        target: schema.spendLimits.projectId,
        set: { monthlyLimitMicros: p.monthlyBudgetMicros, updatedAt: new Date() },
      });

    // Rename pass: legacy vendor-named defaults become business-named staff.
    for (const [oldName, newName] of STAFF_RENAMES) {
      await db
        .update(schema.agents)
        .set({ name: newName, updatedAt: new Date() })
        .where(
          and(eq(schema.agents.projectId, project.id), eq(schema.agents.name, oldName)),
        );
    }

    for (const agent of DEFAULT_AGENTS) {
      // Default agents are seed-managed: model and prompt reset on re-run
      // (standard-tier defaults, D-014). Rename an agent to opt it out.
      // All defaults are Engineering employees until specialized roles exist.
      await db
        .insert(schema.agents)
        .values({
          orgId: org.id,
          projectId: project.id,
          name: agent.name,
          role: agent.role,
          departmentId: engineering.id,
          provider: agent.provider,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
        })
        .onConflictDoUpdate({
          target: [schema.agents.projectId, schema.agents.name],
          set: {
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            departmentId: engineering.id,
            updatedAt: new Date(),
          },
        });
    }

    // Charter as company knowledge (K1). Insert-if-absent by (project, title):
    // knowledge is versioned, so a blind upsert would be wrong — revisions go
    // through reviseKnowledge, never the seed.
    const existingCharter = await db
      .select({ id: schema.knowledgeItems.id })
      .from(schema.knowledgeItems)
      .where(
        and(
          eq(schema.knowledgeItems.projectId, project.id),
          eq(schema.knowledgeItems.title, 'Project charter'),
        ),
      )
      .limit(1);
    if (existingCharter.length === 0) {
      await db.insert(schema.knowledgeItems).values({
        orgId: org.id,
        projectId: project.id,
        scope: 'project',
        kind: 'fact',
        title: 'Project charter',
        body: `${p.name}: ${p.description} This charter is company knowledge, consulted by every employee before work in this project only.`,
        status: 'active',
        source: 'manual',
        createdBy: owner.id,
        approvedBy: owner.id,
        approvedAt: new Date(),
      });
    }
  }

  // E2E sandboxes: only when an E2E account is configured. Two workspaces so
  // the isolation smoke has a second tenant; tiny budget; the E2E profile is
  // a placeholder that upsertProfile relinks on the account's first sign-in.
  const e2eEmail = process.env.E2E_EMAIL;
  if (e2eEmail) {
    console.log(`Seeding E2E sandboxes for ${e2eEmail}…`);
    await db
      .insert(schema.profiles)
      .values({ id: randomUUID(), email: e2eEmail, displayName: 'E2E Test User' })
      .onConflictDoNothing({ target: schema.profiles.email });
    const e2eUser = (
      await db.select().from(schema.profiles).where(eq(schema.profiles.email, e2eEmail)).limit(1)
    )[0];
    if (!e2eUser) throw new Error('Failed to upsert E2E profile.');

    await db
      .insert(schema.memberships)
      .values({ orgId: org.id, userId: e2eUser.id, role: 'member' })
      .onConflictDoNothing();

    for (const sandbox of [
      { key: 'e2e-sandbox', name: 'E2E Sandbox' },
      { key: 'e2e-sandbox-b', name: 'E2E Sandbox B' },
    ]) {
      await db
        .insert(schema.projects)
        .values({
          orgId: org.id,
          key: sandbox.key,
          name: sandbox.name,
          description: 'Automated test workspace. Safe to clear.',
        })
        .onConflictDoNothing();
      const proj = (
        await db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.key, sandbox.key))
          .limit(1)
      )[0];
      if (!proj) throw new Error(`Failed to upsert ${sandbox.key}`);

      for (const member of [e2eUser.id, owner.id]) {
        await db
          .insert(schema.projectMembers)
          .values({ orgId: org.id, projectId: proj.id, userId: member, role: 'admin' })
          .onConflictDoNothing();
      }
      await db
        .insert(schema.spendLimits)
        .values({ orgId: org.id, projectId: proj.id, monthlyLimitMicros: 5_000_000n }) // $5
        .onConflictDoUpdate({
          target: schema.spendLimits.projectId,
          set: { monthlyLimitMicros: 5_000_000n, updatedAt: new Date() },
        });
      // Same rename pass as real workspaces, so sandboxes never fork naming.
      for (const [oldName, newName] of STAFF_RENAMES) {
        await db
          .update(schema.agents)
          .set({ name: newName, updatedAt: new Date() })
          .where(and(eq(schema.agents.projectId, proj.id), eq(schema.agents.name, oldName)));
      }
      for (const agent of DEFAULT_AGENTS) {
        await db
          .insert(schema.agents)
          .values({
            orgId: org.id,
            projectId: proj.id,
            name: agent.name,
            role: agent.role,
            departmentId: engineering.id,
            provider: agent.provider,
            model: agent.model,
            systemPrompt: agent.systemPrompt,
          })
          .onConflictDoNothing();
      }
    }
  }

  console.log('Seed complete.');
  console.log(`Owner profile id: ${owner.id}`);
  if (!process.env.SEED_OWNER_ID) {
    console.log(
      'NOTE: sign up in the app with the same email to link this profile to your Supabase auth user, or re-run with SEED_OWNER_ID=<auth user id>.',
    );
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
