/**
 * HUB-006 read-only verification against accuratebids-com. Uses the REAL domain search to prove the
 * historical Pilot-launch events are discoverable and that keyset pagination walks the whole history
 * with no duplicates or omissions. NEVER mutates.
 *   npx tsx --conditions=react-server scripts/hub006-verify.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { searchAuditEvents } from '@/domain/audit/audit';
import type { TenantContext } from '@/types/domain';

const PILOT_TASK = '45b81577-fb9b-44a7-8fd6-c1bc34403447';
const APPROVAL_IDS = ['fdddef8f', '28a124c3', 'b70e0f74', '1ebfb720'];

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key = 'accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };

  const search = (f = {}, o = {}) => withTenant(ctx, (tx) => searchAuditEvents(tx, ctx, f, o));

  // 1) Pilot launch task events (entity filter).
  const taskEvents = await search({ entityType: 'task', entityId: PILOT_TASK });
  const taskActions = taskEvents.rows.map((r) => `${r.action}@${r.seq}`);
  console.log('PILOT TASK events:', JSON.stringify(taskActions));
  console.log('  task.created found:', taskEvents.rows.some((r) => r.action === 'task.created'));
  console.log('  task.authorization_reconciled found (HUB-001):', taskEvents.rows.some((r) => r.action === 'task.authorization_reconciled'));

  // 2) The four approval authorization decisions.
  console.log('\nFOUR APPROVAL AUTHORIZATION DECISIONS:');
  for (const short of APPROVAL_IDS) {
    const full = (await admin`select id from approvals where id::text like ${short + '%'}`)[0];
    const evs = await search({ entityId: full!.id });
    const decided = evs.rows.filter((r) => r.action === 'approval.decided');
    console.log(`  approval ${short}: ${evs.rows.map((r) => r.action + '@' + r.seq).join(', ')} | approval.decided found: ${decided.length === 1}`);
  }

  // 3) Prefix + free-text discovery from the whole history (not just the newest 100).
  const prefix = await search({ actionPrefix: 'approval.' });
  console.log('\nactionPrefix "approval." totalCount =', prefix.totalCount, '(all discoverable, beyond the old 100 cap)');
  const withdrawn = await search({ action: 'approval.withdrawn' });
  console.log('approval.withdrawn / recovery events (report only if they exist):', withdrawn.totalCount);

  // 4) Pagination completeness — walk the ENTIRE history, assert no dup / no omission.
  const total = (await search({})).totalCount;
  const seen = new Set<string>();
  let cursor: bigint | null = null;
  let pages = 0;
  let dup = false;
  for (;;) {
    const r: Awaited<ReturnType<typeof searchAuditEvents>> = await search({}, { cursorSeq: cursor, limit: 50 });
    for (const row of r.rows) { if (seen.has(row.id)) dup = true; seen.add(row.id); }
    pages += 1;
    if (!r.nextCursor) break;
    cursor = BigInt(r.nextCursor);
    if (pages > 100) break;
  }
  console.log('\nPAGINATION: total =', total, '| retrieved =', seen.size, '| pages =', pages, '| duplicates =', dup, '| complete =', seen.size === total && !dup);

  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
