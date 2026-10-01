/**
 * TEST-ONLY seed for the browser run-to-result checks (tests/e2e/review-run-to-result.spec.ts). Creates, in
 * the `e2e-sandbox` workspace only, a pinned primary + reviewer employee and three PENDING tasks — allowed
 * Quick (exempt), Reviewed, and a forced-Reviewed-with-reviewer-failure (its brief carries the REVIEWFAIL
 * marker the in-app fake reviewer fails on). Writes the ids to the file in $RTR_IDS_FILE so the Playwright spec
 * (which cannot import server-only DB code) can drive them and a psql dump can read their persisted state.
 *
 * Never touches any workspace other than e2e-sandbox; makes no model call.
 */
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getSetupDb } from '../src/db/client';
import { agents, projectMembers, projects, tasks } from '../src/db/schema';

async function main() {
  const out = process.env.RTR_IDS_FILE;
  if (!out) throw new Error('RTR_IDS_FILE env must point to the ids output file');
  const db = getSetupDb();
  const proj = (await db.select().from(projects).where(eq(projects.key, 'e2e-sandbox')).limit(1))[0];
  if (!proj) throw new Error('e2e-sandbox workspace not found — run `E2E_EMAIL=… npm run db:seed` first');
  const { id: projectId, orgId } = proj;
  const member = (await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)).limit(1))[0];
  if (!member) throw new Error('no project member to attribute tasks to');
  const createdBy = member.userId;

  const primary = (
    await db.insert(agents).values({ orgId, projectId, name: `RTR Primary ${Date.now()}`, role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'You are primary.', temperatureMilli: 700, maxOutputTokens: 2048 }).returning({ id: agents.id })
  )[0]!.id;
  const reviewer = (
    await db.insert(agents).values({ orgId, projectId, name: `RTR Reviewer ${Date.now()}`, role: 'reviewer', provider: 'anthropic', model: 'claude-x', systemPrompt: 'You are reviewer.', temperatureMilli: 500, maxOutputTokens: 2048 }).returning({ id: agents.id })
  )[0]!.id;

  const mk = async (o: { title: string; input: string; reviewEnabled: boolean; quickExempt: boolean | null; withReviewer: boolean }) =>
    (
      await db.insert(tasks).values({
        orgId, projectId, title: o.title, input: o.input, providerSelection: 'both',
        reviewEnabled: o.reviewEnabled, quickExempt: o.quickExempt, status: 'pending', createdBy,
        assignedPrimaryAgentId: primary, assignedReviewerAgentId: o.withReviewer ? reviewer : null,
      }).returning({ id: tasks.id })
    )[0]!.id;

  const ids = {
    projectKey: 'e2e-sandbox',
    quick: await mk({ title: 'RTR Quick (exempt)', input: 'Reply briefly.', reviewEnabled: false, quickExempt: true, withReviewer: false }),
    reviewed: await mk({ title: 'RTR Reviewed', input: 'Reply briefly.', reviewEnabled: true, quickExempt: null, withReviewer: true }),
    forcedFail: await mk({ title: 'RTR Forced+ReviewerFail', input: 'Reply briefly. REVIEWFAIL', reviewEnabled: false, quickExempt: false, withReviewer: true }),
  };
  writeFileSync(out, JSON.stringify(ids, null, 2));
  console.log('RTR seed complete:', JSON.stringify(ids));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
