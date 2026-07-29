/**
 * HUB-008 UI-proof seeder (staging, NON-BILLABLE). Creates a THROWAWAY demo project in the owner's org and
 * drives the REAL production dispatch path (startRun → getProvider) with a fake provider injected via the
 * registry test seam — no external model call, no spend, and NO change to any real AccurateBids business
 * evidence. Produces one genuine EXACT-identity run so the run-detail "Prompt identity" panel can be verified
 * in the authenticated UI. Also prints a real pre-feature (unavailable) run URL from accuratebids-com.
 *
 *   npx tsx --conditions=react-server scripts/hub008-seed-ui-proof.ts          # seed + print URLs
 *   npx tsx --conditions=react-server scripts/hub008-seed-ui-proof.ts cleanup  # archive + delete the demo
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { createObjective, setObjectiveStatus } from '@/domain/objectives/objectives';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';
import type { TenantContext } from '@/types/domain';
import type { AgentRequest, AgentResponse, AIProvider, ModelDescriptor, ProviderId } from '@/types/provider';

const DEMO_KEY = 'hub008-uiproof';

class Fake implements AIProvider {
  readonly id: ProviderId;
  private q: string[];
  constructor(id: ProviderId, replies: string[]) { this.id = id; this.q = [...replies]; }
  async execute(r: AgentRequest): Promise<AgentResponse> {
    return { provider: this.id, model: r.model, text: this.q.shift() ?? 'ok', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'stop', latencyMs: 1 };
  }
  listModels(): readonly ModelDescriptor[] { return [{ id: 'fake', provider: this.id, displayName: 'Fake', maxOutputTokens: 4096 }]; }
}

const REVIEWER_REVISE = `VERDICT: revise\n\nOne issue.\n\n\`\`\`review-issues\n[{"severity":"minor","summary":"Add a Stripe-connection verification step","detail":"Require the contractor to connect their own Stripe account before activation."}]\n\`\`\``;

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const mode = process.argv[2] ?? 'seed';

  // Column presence check (proves migration 0050 applied).
  const col = await admin`select column_name from information_schema.columns where table_name='run_steps' and column_name='effective_prompt_hash'`;
  console.log('run_steps.effective_prompt_hash column:', col.length ? 'present' : 'MISSING');

  const ab = (await admin`select id, org_id from projects where key='accuratebids-com'`)[0];
  if (!ab) throw new Error('accuratebids-com not found');
  const orgId = ab.org_id as string;
  const adminUser = (await admin`select user_id from project_members where project_id=${ab.id} and role='admin' limit 1`)[0];
  if (!adminUser) throw new Error('no admin user');
  const userId = adminUser.user_id as string;

  if (mode === 'cleanup') {
    const demo = (await admin`select id from projects where key=${DEMO_KEY} and org_id=${orgId}`)[0];
    if (!demo) { console.log('no demo project to clean'); await admin.end(); return; }
    // Runs + messages + audit rows are append-only by design (immutability triggers), so we ARCHIVE the
    // throwaway demo project rather than violate that invariant — this removes it from the workspace list
    // and every operator surface without touching real AccurateBids data.
    await admin`update projects set archived = true where id=${demo.id}`;
    console.log('archived demo project', DEMO_KEY, '(append-only run records retained, project hidden)');
    await admin.end();
    return;
  }

  // Fresh demo project in the owner's org (owner is admin → visible in the authenticated UI).
  await admin`delete from projects where key=${DEMO_KEY} and org_id=${orgId}`; // idempotent reseed
  const pid = (await admin`insert into projects (org_id, key, name, classification) values (${orgId}, ${DEMO_KEY}, 'HUB-008 UI proof (demo)', 'demo') returning id`)[0]!.id as string;
  await admin`insert into project_members (org_id, project_id, user_id, role) values (${orgId}, ${pid}, ${userId}, 'admin')`;
  await admin`insert into spend_limits (org_id, project_id, monthly_limit_micros) values (${orgId}, ${pid}, 100000000)`;
  await admin`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${pid}, 'Lead Engineer', 'primary', 'openai', 'gpt-x', 'You are the primary engineer.', 700, 4096)`;
  await admin`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${pid}, 'Principal Reviewer', 'reviewer', 'anthropic', 'claude-x', 'You are the reviewer.', 500, 4096)`;

  const ctx: TenantContext = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const objectiveId = await withTenant(ctx, (tx) =>
    createObjective(tx, ctx, { title: 'Activate first 3 pilot contractors', description: 'Controlled pilot activation.', successCriteria: [{ label: 'Contractor independently sends one real quote using their own Stripe account', metric: 'contractors_activated', target: 3, unit: 'contractors' }] }),
  );
  await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'active'));
  await admin`insert into decisions (org_id, project_id, title, summary, author_label, status, scope) values (${orgId}, ${pid}, 'Activation evidence standard', 'Own-Stripe, independent send, real quote, real customer.', 'Founder', 'accepted', 'workspace')`;
  const taskId = (await admin`insert into tasks (org_id, project_id, title, input, provider_selection, review_enabled, status, created_by, objective_id) values (${orgId}, ${pid}, 'Pilot activation checklist', 'Draft a pilot activation checklist for contractor A.', 'both', true, 'pending', ${userId}, ${objectiveId}) returning id`)[0]!.id as string;

  setProviderOverrideForTests((id) => (id === 'openai' ? new Fake('openai', ['Primary draft checklist.', 'Revised checklist with Stripe step.']) : id === 'anthropic' ? new Fake('anthropic', [REVIEWER_REVISE]) : undefined));
  const outcome = await startRun(ctx, taskId);
  setProviderOverrideForTests(null);
  console.log('synthetic run outcome:', outcome.status);

  // A real pre-feature (unavailable) run on accuratebids-com for the other half of the UI check.
  const preFeature = (await admin`
    select t.id as task_id, t.title from runs r join tasks t on t.id=r.task_id
    where r.project_id=${ab.id} and r.primary_effective_prompt_hash is null
    order by r.created_at desc limit 1`)[0];

  console.log('\n=== AUTHENTICATED UI VERIFICATION URLS ===');
  console.log('EXACT-identity (synthetic, demo):  /p/' + DEMO_KEY + '/tasks/' + taskId);
  if (preFeature) console.log('UNAVAILABLE (real pre-feature):    /p/accuratebids-com/tasks/' + preFeature.task_id + '   [' + preFeature.title + ']');
  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
