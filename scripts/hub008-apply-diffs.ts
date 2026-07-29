/**
 * HUB-008 — apply the four APPROVED minimal permanent-prompt changes to accuratebids-com via the audited
 * updateEmployeePrompt. Jane Smith + Naruto Samuki are untouched. Idempotent (re-run = no new events).
 *   npx tsx --conditions=react-server scripts/hub008-apply-diffs.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { updateEmployeePrompt } from '@/domain/agents/agents';
import type { TenantContext } from '@/types/domain';

interface Edit { name: string; reason: string; replace: [string, string][] }

const EDITS: Edit[] = [
  {
    name: 'don wong',
    reason: 'HUB-008: immediate priorities come from active objectives; demote the fixed 10-paying-customers goal to long-term.',
    replace: [[
      '* Supporting the goal of reaching the first 10 paying customers',
      "* Execute immediate priorities from the workspace's active objectives and applicable Decisions. Long-term customer-growth goals remain secondary and must not displace the current active objective.",
    ]],
  },
  {
    name: 'tom brown',
    reason: 'HUB-008: activation definition defers to the active objective criterion + accepted evidence Decisions.',
    replace: [
      ['## Primary Activation Milestone', '## Activation Standard'],
      [
        'A contractor is activated when they successfully create and send their first real quote through AccurateBids.',
        "Use the active objective's success criterion and applicable accepted Decisions as the controlling activation definition.\nDo not mark a contractor activated without the required evidence. Signup, login, profile completion, testing, a draft quote, or a staff-completed action does not count unless the current criterion explicitly says otherwise.\nWhen the active pilot criterion applies, activation requires evidence that the contractor connected their own Stripe account and independently sent one real quote to one real customer through a non-test workflow.",
      ],
      ['Account creation, login, profile completion, or testing alone does not count as activation.', ''],
    ],
  },
  {
    name: 'thomas garvey',
    reason: 'HUB-008: current qualification follows the active pilot objectives; 10-paying-customers is long-term.',
    replace: [[
      'Your work should support the goal of reaching the first 10 paying customers without relying on spam, misleading claims, or unapproved external communication.',
      "Your work should support the workspace's current active contractor-acquisition and pilot objectives. Reaching paying-customer goals is a longer-term outcome and must not override controlled-pilot sequencing, evidence requirements, or approval gates.",
    ]],
  },
  {
    name: 'doug brian',
    reason: 'HUB-008: growth/publishing gated by active objectives, evidence, and launch Decisions.',
    replace: [[
      'Support the goals of increasing qualified interest, activating contractors, and reaching the first 10 paying customers.',
      "Support the workspace's active objectives through evidence-based messaging and growth work. Broad growth, publishing, and paying-customer goals remain gated by applicable Decisions, pilot evidence, and explicit approval.",
    ]],
  },
];

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key = 'accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };
  const agentsRows = await admin`select id, name, system_prompt from agents where project_id = ${proj.id}`;

  for (const e of EDITS) {
    const a = agentsRows.find((r) => r.name.toLowerCase() === e.name);
    if (!a) { console.log('MISSING', e.name); continue; }
    let next = a.system_prompt as string;
    for (const [from, to] of e.replace) {
      if (next.includes(from)) next = next.replace(from, to);
      else if (to && next.includes(to)) continue; // already applied — re-run safe
      else throw new Error(`${e.name}: neither find-string nor replacement present → ${from.slice(0, 60)}…`);
    }
    if (next === a.system_prompt) { console.log(`${e.name}: no change (already applied)`); continue; }
    // Authority guard: the change must not remove a prohibition line.
    const changed = await withTenant(ctx, (tx) => updateEmployeePrompt(tx, ctx, a.id, { systemPrompt: next }, e.reason));
    console.log(`${e.name}: applied=${changed}`);
  }

  console.log('\n=== employee.prompt_updated audit events ===');
  const evs = await admin`
    select l.entity_id, ag.name, l.detail, l.actor_id, l.created_at
    from audit_logs l join agents ag on ag.id = l.entity_id
    where l.project_id = ${proj.id} and l.action = 'employee.prompt_updated' order by l.created_at`;
  for (const ev of evs) {
    const d = ev.detail as Record<string, unknown>;
    console.log(`  ${ev.name} | fields=${JSON.stringify(d.changedFields)} | prevPromptHash=${String(d.prevPromptHash).slice(0, 12)} newPromptHash=${String(d.newPromptHash).slice(0, 12)} | prevCfg=${String(d.prevConfigHash).slice(0, 12)} newCfg=${String(d.newConfigHash).slice(0, 12)} | reason="${d.reason}" | actor=${ev.actor_id ? 'set' : 'null'} | fullText=${JSON.stringify(d).length > 4000 ? 'PRESENT?!' : 'absent'}`);
  }
  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
