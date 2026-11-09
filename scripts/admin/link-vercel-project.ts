import { config as loadDotenv } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { getPool } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { linkVercelProject, listVercelProjectLinks } from '@/domain/vercel/links';
import { type TenantContext } from '@/types/domain';

/**
 * Bind one external Vercel project to a Hub workspace — the missing link path.
 *
 * WHY THIS EXISTS
 *
 * `linkVercelProject()` (src/domain/vercel/links.ts) shipped with Phase 2D but had NO production
 * caller: no API route, no admin page, no script. Only tests/integration/vercel-links.test.ts called
 * it. That made enabling `vercel_mutation` a bridge to nowhere — `VercelMutationExecutor` resolves its
 * target through `listVercelProjectLinks` at the dispatch choke point, so with a VERCEL_TOKEN set and
 * `vercel_mutation` in EXECUTORS_ENABLED every action would still refuse for want of a link row.
 *
 * Enabling the Vercel connector takes all THREE of these, and this script is only the third:
 *   1. VERCEL_TOKEN present              (a Fly secret; absent ⇒ the client fails closed)
 *   2. `vercel_mutation` in EXECUTORS_ENABLED (a Fly secret; unset ⇒ every executor is disabled)
 *   3. a vercel_project_links row for the workspace  ← this script
 *
 * WHAT IT DOES NOT DO
 *
 * It reads NO secret. A link row holds identifiers only — the Vercel API token never enters the
 * database, so nothing here touches VERCEL_TOKEN and nothing it prints can leak one. It makes no
 * network call to Vercel: the project id is recorded as given, not verified against the Vercel API.
 *
 * AUTHORITY IS VERIFIED, NOT ASSERTED
 *
 * `linkVercelProject()` enforces `projectRole === 'admin'` on the TenantContext it is handed, so a
 * script that fabricates `projectRole: 'admin'` satisfies the check without anyone actually being an
 * admin. This script instead READS the actor's real roles from `project_members` and `memberships` and
 * refuses unless the database itself says they are a project admin. The write then runs inside
 * `withTenant`, so the insert and its audit row go through the ordinary RLS tenant boundary on the
 * non-superuser app role — not around it.
 *
 * Resolution of the project and the actor happens on DATABASE_MIGRATION_URL when it is set, because
 * the identity tables are RLS-scoped and there is no tenant context to set yet; under the app role
 * those reads would come back a false empty. The WRITE never uses that connection.
 *
 * PREVIEW BY DEFAULT
 *
 * Without --confirm the script resolves, validates, reports and writes nothing. Re-run with --confirm
 * to insert. Re-running after a successful link is a no-op, not a unique-violation crash.
 *
 *   npm run admin:link-vercel-project -- \
 *     --project accuratebids --actor owner@example.com --vercel-project-id prj_abc12345
 *   npm run admin:link-vercel-project -- ... --confirm
 */

// Next.js loads `.env.local` on its own, but plain `tsx` does not and `dotenv/config` reads only
// `.env` — which this repo does not have, so DATABASE_URL came back unset. Load both files with
// Next's precedence (.env.local wins over .env) and, because dotenv never overrides an existing
// value, let real environment variables beat both. That is what Fly supplies.
loadDotenv({ path: '.env.local', quiet: true });
loadDotenv({ quiet: true });

const FLAGS = new Set(['project', 'actor', 'vercel-project-id', 'team-id', 'label']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal that is the operator's to fix — reported as a message, never a stack trace. */
class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run admin:link-vercel-project -- --project <id|key> --actor <id|email> \\',
    '      --vercel-project-id prj_… [--team-id team_…] [--label "…"] [--confirm]',
    '',
    '  --project             Hub project, by uuid or by key',
    '  --actor               the project ADMIN the link is recorded as; uuid or email',
    '  --vercel-project-id   Vercel project id (prj_…)',
    '  --team-id             optional Vercel team id (team_…)',
    '  --label               optional human label for the link',
    '  --confirm             actually write; omitted ⇒ preview only, nothing is written',
  ].join('\n');
}

interface Args {
  readonly project?: string;
  readonly actor?: string;
  readonly vercelProjectId?: string;
  readonly teamId?: string;
  readonly label?: string;
  readonly confirm: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const seen: Record<string, string> = {};
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (raw === '--confirm') {
      confirm = true;
      continue;
    }
    if (!raw.startsWith('--')) refuse(`unexpected argument "${raw}"\n\n${usage()}`);
    const at = raw.indexOf('=');
    const name = at === -1 ? raw.slice(2) : raw.slice(2, at);
    if (!FLAGS.has(name)) refuse(`unknown flag "--${name}"\n\n${usage()}`);
    if (seen[name] !== undefined) refuse(`--${name} was given twice`);
    const value = at === -1 ? argv[(i += 1)] : raw.slice(at + 1);
    if (value === undefined || value === '' || value.startsWith('--')) refuse(`--${name} needs a value`);
    seen[name] = value;
  }
  return {
    project: seen.project,
    actor: seen.actor,
    vercelProjectId: seen['vercel-project-id'],
    teamId: seen['team-id'],
    label: seen.label,
    confirm,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.actor || !args.vercelProjectId) {
    refuse(`--project, --actor and --vercel-project-id are all required\n\n${usage()}`);
  }

  // Cheap pre-checks so a typo is caught in PREVIEW too. The zod `linkSchema` in
  // src/domain/vercel/links.ts stays authoritative on write; these only mirror it.
  if (!/^prj_[A-Za-z0-9]{8,64}$/.test(args.vercelProjectId)) {
    refuse(`--vercel-project-id must look like prj_… (got "${args.vercelProjectId}")`);
  }
  if (args.teamId !== undefined && !/^team_[A-Za-z0-9]{8,64}$/.test(args.teamId)) {
    refuse(`--team-id must look like team_… (got "${args.teamId}")`);
  }

  const resolutionUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!resolutionUrl) refuse('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const resolver = postgres(resolutionUrl, { max: 1, onnotice: () => {} });
  let tenantDbUsed = false;

  try {
    const rdb = drizzle(resolver, { schema });

    // --- the project -------------------------------------------------------------------------
    // `projects.key` is unique per ORG, not globally, so a key can legitimately match more than one
    // row. Ask for two and refuse on ambiguity rather than silently taking the first.
    const projectRows = UUID.test(args.project)
      ? await rdb.select().from(schema.projects).where(eq(schema.projects.id, args.project)).limit(2)
      : await rdb.select().from(schema.projects).where(eq(schema.projects.key, args.project)).limit(2);
    if (projectRows.length === 0) {
      refuse(
        `project "${args.project}" was not found.\n` +
          'If DATABASE_MIGRATION_URL is unset, the app role cannot read identity tables without a ' +
          'tenant context and this read returns a FALSE EMPTY — set it and re-run.',
      );
    }
    if (projectRows.length > 1) {
      refuse(`project key "${args.project}" matches more than one org; pass the project uuid instead.`);
    }
    const project = projectRows[0]!;

    // --- the actor ---------------------------------------------------------------------------
    const actorRows = UUID.test(args.actor)
      ? await rdb.select().from(schema.profiles).where(eq(schema.profiles.id, args.actor)).limit(1)
      : await rdb.select().from(schema.profiles).where(eq(schema.profiles.email, args.actor)).limit(1);
    const actor = actorRows[0];
    if (!actor) refuse(`actor "${args.actor}" was not found.`);

    // --- their REAL roles, read from the database --------------------------------------------
    const projectMemberRow = (
      await rdb
        .select({ role: schema.projectMembers.role })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, project.id),
            eq(schema.projectMembers.userId, actor.id),
          ),
        )
        .limit(1)
    )[0];
    if (!projectMemberRow) refuse(`${actor.email} is not a member of project "${project.key}".`);
    if (projectMemberRow.role !== 'admin') {
      refuse(
        `${actor.email} has project role "${projectMemberRow.role}", not "admin". ` +
          'Linking a Vercel project requires the project admin role.',
      );
    }
    const orgMemberRow = (
      await rdb
        .select({ role: schema.memberships.role })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.orgId, project.orgId), eq(schema.memberships.userId, actor.id)))
        .limit(1)
    )[0];
    if (!orgMemberRow) refuse(`${actor.email} has no org membership in the project's organization.`);

    const ctx: TenantContext = {
      userId: actor.id,
      orgId: project.orgId,
      projectId: project.id,
      orgRole: orgMemberRow.role,
      projectRole: projectMemberRow.role,
    };

    // --- report, then act --------------------------------------------------------------------
    tenantDbUsed = true;
    const before = await withTenant(ctx, (tx) => listVercelProjectLinks(tx, ctx));

    console.log('Vercel project link');
    console.log(`  workspace     ${project.key} (${project.id})${project.archived ? '  [ARCHIVED]' : ''}`);
    console.log(`  actor         ${actor.email}  org=${ctx.orgRole} project=${ctx.projectRole}`);
    console.log(`  vercel project ${args.vercelProjectId}${args.teamId ? `  team=${args.teamId}` : ''}`);
    if (args.label) console.log(`  label         ${args.label}`);
    console.log(`  existing links ${before.length === 0 ? '(none)' : ''}`);
    for (const l of before) {
      console.log(`    - ${l.vercelProjectId}${l.label ? ` "${l.label}"` : ''}  (${l.id})`);
    }
    if (project.archived) {
      console.warn('  WARNING: this workspace is ARCHIVED. Linking a deploy capability to it is almost');
      console.warn('           certainly a mistake — check the --project value before confirming.');
    }

    const already = before.find((l) => l.vercelProjectId === args.vercelProjectId);
    if (already) {
      console.log(`\nAlready linked as ${already.id}. Nothing to do.`);
      return;
    }

    if (!args.confirm) {
      console.log('\nPREVIEW ONLY — nothing was written. Re-run with --confirm to insert the row.');
      return;
    }

    const linkId = await withTenant(ctx, (tx) =>
      linkVercelProject(tx, ctx, {
        vercelProjectId: args.vercelProjectId!,
        vercelTeamId: args.teamId,
        label: args.label,
      }),
    );
    const after = await withTenant(ctx, (tx) => listVercelProjectLinks(tx, ctx));
    const written = after.find((l) => l.id === linkId);
    if (!written) refuse(`the link was reported as ${linkId} but is not readable back — investigate.`);
    console.log(`\nLinked. id=${linkId}  (${after.length} link(s) now on ${project.key})`);
    console.log('An audit row `vercel.project_linked` was written in the same transaction.');
    console.log(
      'This does NOT enable the connector: VERCEL_TOKEN must be present and `vercel_mutation` must be ' +
        'in EXECUTORS_ENABLED before any Vercel action can dispatch.',
    );
  } finally {
    await resolver.end();
    if (tenantDbUsed) await getPool().end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    if (err instanceof Refusal) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
