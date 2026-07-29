/**
 * HUB-008 read-only effective-prompt previews for the six business employees on accuratebids-com.
 * Uses the REAL assembler. NEVER mutates any prompt.
 *   npx tsx --conditions=react-server scripts/hub008-preview.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { assembleCurrentOperatingPriorities, effectivePromptPreview } from '@/domain/prompts/effective-prompt';
import type { TenantContext } from '@/types/domain';

const NAMES = ['don wong', 'tom brown', 'thomas garvey', 'doug brian', 'jane smith', 'naruto samuki'];

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key = 'accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };
  const agentsRows = await admin`select id, name from agents where project_id = ${proj.id}`;

  const priorities = await withTenant(ctx, (tx) => assembleCurrentOperatingPriorities(tx, ctx));
  console.log('===== CURRENT OPERATING PRIORITIES (shared, dynamic) =====');
  console.log(priorities.text);
  console.log('\nhasActiveObjective:', priorities.hasActiveObjective, '| activeObjectives:', priorities.objectives.map((o) => o.title));
  console.log('activeDecisions:', priorities.decisions.map((d) => d.title));

  for (const name of NAMES) {
    const row = agentsRows.find((a) => a.name.toLowerCase() === name);
    if (!row) { console.log(`\n### MISSING: ${name}`); continue; }
    const ep = await withTenant(ctx, (tx) => effectivePromptPreview(tx, ctx, row.id));
    if (!ep) continue;
    console.log(`\n========== ${ep.agentName} ==========`);
    console.log('configurationHash :', ep.configurationHash.slice(0, 16), '…');
    console.log('effectivePromptHash:', ep.effectivePromptHash.slice(0, 16), '…');
    console.log('stableRole (first line):', ep.stableRolePrompt.split('\n')[0]);
    console.log('active objective in prompt:', ep.composed.includes('Activate first 3 pilot contractors'));
    console.log('criterion (Stripe/independent) in prompt:', /own Stripe account/i.test(ep.composed) || /independently send/i.test(ep.composed));
    console.log('applicable Decisions:', ep.activeDecisions.map((d) => d.title));
    console.log('authority restriction retained (system prompt):', /You may not/i.test(ep.stableRolePrompt));
    const staleTen = /first 10 paying customers|10 paying customers/i.test(ep.stableRolePrompt);
    console.log('stale "10 paying customers" in STANDING prompt (now superseded by dynamic priorities):', staleTen);
    console.log('hard-coded activation "first real quote" in STANDING prompt:', /first real quote/i.test(ep.stableRolePrompt));
  }
  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
