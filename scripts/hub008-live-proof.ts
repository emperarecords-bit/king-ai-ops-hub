/**
 * HUB-008 read-only proof that the live runner's canonical assembler injects Current Operating Priorities
 * and would record the reproducibility identity — reproduced for a REAL task on accuratebids-com. NEVER
 * mutates and makes NO provider call. Also reports any post-feature run's persisted identity + reproducibility.
 *   npx tsx --conditions=react-server scripts/hub008-live-proof.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { assembleCurrentOperatingPriorities } from '@/domain/prompts/effective-prompt';
import { classifyRunReproducibility, RUN_REPRODUCIBILITY_LABEL } from '@/domain/prompts/effective-prompt';
import { assembleEffectivePrompt, ASSEMBLER_VERSION } from '@/orchestration/prompts';
import { agentExecutionFingerprint } from '@/domain/agents/agents';
import { sha256Hex } from '@/lib/crypto';
import type { TenantContext } from '@/types/domain';

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key='accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id=${proj.id} and role='admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };

  // Reproduce, for a REAL completed task, exactly what the runner assembles at dispatch.
  const task = (await admin`select id, input, objective_id from tasks where title='Create first-3 pilot activation plan'`)[0];
  const agent = (await admin`select id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens from agents where name='Lead Engineer' and project_id=${proj.id}`)[0];
  if (!task || !agent) throw new Error('task or agent not found');

  const priorities = await withTenant(ctx, (tx) => assembleCurrentOperatingPriorities(tx, ctx, task.id));
  const assembled = assembleEffectivePrompt({
    variant: 'primary', agentSystemPrompt: agent.system_prompt, taskInput: task.input,
    operatingPriorities: priorities.text, contextItems: [], objective: null,
  });
  const effHash = sha256Hex(`${assembled.system}\n${assembled.userTurn}`);
  const cfgHash = agentExecutionFingerprint({ provider: agent.provider, model: agent.model, systemPrompt: agent.system_prompt, temperatureMilli: agent.temperature_milli, maxOutputTokens: agent.max_output_tokens, role: agent.role });

  console.log('=== LIVE RUNNER ASSEMBLY PROOF (real task, no provider call) ===');
  console.log('assembler version         :', ASSEMBLER_VERSION);
  console.log('priorities injected once  :', (assembled.userTurn.match(/CURRENT OPERATING PRIORITIES/g) ?? []).length === 1);
  console.log('active objective in prompt:', assembled.userTurn.includes('Activate first 3 pilot contractors'));
  console.log('activation criterion present:', /own Stripe account/i.test(assembled.userTurn));
  console.log('applicable Decisions       :', priorities.decisions.length);
  console.log('primary effective-prompt hash (would persist):', effHash.slice(0, 20), '…');
  console.log('primary config hash        :', cfgHash.slice(0, 20), '…');
  console.log('source-manifest kinds      :', [
    task.objective_id ? 'objective' : null,
    ...priorities.decisions.slice(0, 1).map(() => 'decision'),
    'task',
  ].filter(Boolean).join(', '), `(+${priorities.decisions.length} decisions)`);

  // Reproducibility classification of EXISTING runs (pre-feature runs must read "unavailable", never faked).
  console.log('\n=== EXISTING run reproducibility (real) ===');
  const runs = await admin`select id, primary_effective_prompt_hash, primary_config_hash, primary_prompt_hash, source_manifest, assembler_version, created_at from runs where project_id=${proj.id} order by created_at desc limit 12`;
  for (const r of runs) {
    const cls = classifyRunReproducibility({ primaryEffectivePromptHash: r.primary_effective_prompt_hash, primaryConfigHash: r.primary_config_hash, primaryPromptHash: r.primary_prompt_hash, sourceManifest: r.source_manifest });
    console.log(`  run ${r.id.slice(0, 8)} ${r.created_at.toISOString().slice(0,10)} | ${cls} — ${RUN_REPRODUCIBILITY_LABEL[cls]}${r.assembler_version ? ' [' + r.assembler_version + ']' : ''}`);
  }
  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
