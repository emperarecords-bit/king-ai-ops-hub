import 'server-only';
import { listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { morningBriefing, type MorningBriefing, type WorkspaceBriefing } from '@/domain/briefing/briefing';
import { openQuestionsForOwner, type OpenOwnerQuestion } from '@/domain/questions/questions';
import { overallLabel, type OverallHealthState } from '@/domain/health/health';

/**
 * Ops Chat (chat-first front door, v1 READ-ONLY). The "full pulse" — what needs
 * the owner + a one-line health read per workspace — assembled from data the
 * platform already computes (the Morning Briefing) plus open owner questions.
 *
 * Two consumers:
 *  - the landing page renders `openingMessage(pulse)` as the first chat turn
 *    (deterministic, no model call — instant and free);
 *  - the chat endpoint feeds `pulseContext(pulse)` to the model as live context
 *    so free-form questions are answered from real state, never invented.
 */

export interface OpsPulse {
  readonly displayName: string;
  readonly email: string;
  readonly greeting: string;
  readonly totals: MorningBriefing['totals'];
  readonly openQuestions: readonly OpenOwnerQuestion[];
  readonly workspaces: readonly WorkspaceBriefing[];
}

function greetingFor(d: Date): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Gather the live pulse for the signed-in owner. Enforces auth via the guard. */
export async function buildPulse(): Promise<OpsPulse> {
  const { user, projects, orgRoles } = await listMyProjectsWithOrgRoles();
  const [briefing, openQuestions] = await Promise.all([
    morningBriefing(user.id, projects, orgRoles),
    openQuestionsForOwner(user.id, projects, orgRoles),
  ]);
  return {
    displayName: user.displayName,
    email: user.email,
    greeting: greetingFor(new Date()),
    totals: briefing.totals,
    openQuestions,
    workspaces: briefing.workspaces,
  };
}

function healthEmoji(overall: OverallHealthState): string {
  if (overall === 'healthy') return '🟢';
  if (overall === 'operational_with_warnings' || overall === 'unable_to_assess') return '🟡';
  return '🔴';
}

/** One-line activity clause for a workspace (kept short — this is a glance, not a report). */
function activityClause(w: WorkspaceBriefing): string {
  const parts: string[] = [];
  if (w.workingNow > 0) parts.push(`${w.workingNow} working now`);
  if (w.runsCompleted > 0) parts.push(`${w.runsCompleted} done (24h)`);
  if (w.runsFailed > 0) parts.push(`${w.runsFailed} failed`);
  if (w.objectivesAtRisk > 0) parts.push(`${w.objectivesAtRisk} objective${w.objectivesAtRisk === 1 ? '' : 's'} at risk`);
  if (w.spentPct >= 80) parts.push(`budget ${w.spentPct}%`);
  if (parts.length === 0) parts.push('quiet');
  return parts.join(', ');
}

/** The needs-you line, or a calm all-clear. */
function needsYouLine(pulse: OpsPulse): string {
  const bits: string[] = [];
  if (pulse.totals.pendingApprovals > 0) {
    bits.push(`${pulse.totals.pendingApprovals} approval${pulse.totals.pendingApprovals === 1 ? '' : 's'}`);
  }
  if (pulse.openQuestions.length > 0) {
    bits.push(`${pulse.openQuestions.length} question${pulse.openQuestions.length === 1 ? '' : 's'}`);
  }
  if (bits.length === 0) return '✅ Nothing needs you right now.';
  return `⚠️ Needs you: ${bits.join(' · ')}`;
}

/**
 * The deterministic "full pulse" opening message (Markdown). Shown as the first
 * assistant turn on load — no model call.
 */
export function openingMessage(pulse: OpsPulse): string {
  const lines: string[] = [];
  lines.push(`${pulse.greeting}, ${pulse.displayName.split(/\s+/)[0] || pulse.displayName}. Here's your pulse.`);
  lines.push('');
  lines.push(needsYouLine(pulse));

  // Group open questions by workspace for the needs-you detail.
  if (pulse.openQuestions.length > 0) {
    const byWs = new Map<string, number>();
    for (const q of pulse.openQuestions) byWs.set(q.workspaceName, (byWs.get(q.workspaceName) ?? 0) + 1);
    const q = [...byWs.entries()].map(([name, n]) => `${name} (${n})`).join(', ');
    lines.push(`• Questions in: ${q}`);
  }
  if (pulse.totals.pendingApprovals > 0) {
    const withAppr = pulse.workspaces.filter((w) => w.pendingApprovals > 0).map((w) => `${w.projectName} (${w.pendingApprovals})`);
    if (withAppr.length > 0) lines.push(`• Approvals in: ${withAppr.join(', ')}`);
  }

  lines.push('');
  lines.push('**Projects:**');
  for (const w of pulse.workspaces) {
    lines.push(`${healthEmoji(w.overall)} **${w.projectName}** — ${overallLabel(w.overall).toLowerCase()} · ${activityClause(w)}`);
  }
  lines.push('');
  lines.push('_Ask me anything — "how\'s AccurateBids", "why did that run fail", "what\'s StressProbe been doing" — or open the details._');
  return lines.join('\n');
}

/**
 * Compact live-state context for the model. Read-only facts only; the system
 * prompt tells the model to answer strictly from this and never invent.
 */
export function pulseContext(pulse: OpsPulse): string {
  const lines: string[] = [];
  lines.push(`OWNER: ${pulse.displayName} <${pulse.email}>`);
  lines.push(
    `NEEDS OWNER NOW: ${pulse.totals.pendingApprovals} pending approval(s); ${pulse.openQuestions.length} open owner question(s).`,
  );
  lines.push(
    `TOTALS (last 24h unless noted): completedRuns=${pulse.totals.runsCompleted}, failedRuns=${pulse.totals.runsFailed}, workingNow=${pulse.totals.workingNow}, objectivesAtRisk=${pulse.totals.objectivesAtRisk}, reviewInterventions=${pulse.totals.reviewInterventions}, workspacesOverBudget80pct=${pulse.totals.budgetAlerts}.`,
  );

  if (pulse.openQuestions.length > 0) {
    lines.push('OPEN OWNER QUESTIONS:');
    for (const q of pulse.openQuestions.slice(0, 25)) {
      lines.push(`- [${q.workspaceName}] "${q.question}"${q.askedBy ? ` (asked by ${q.askedBy})` : ''}`);
    }
  }

  lines.push('WORKSPACES (health and activity):');
  for (const w of pulse.workspaces) {
    lines.push(
      `- ${w.projectName} [key=${w.projectKey}]: health=${overallLabel(w.overall)}` +
        `; pendingApprovals=${w.pendingApprovals}` +
        `; runsCompleted24h=${w.runsCompleted}; runsFailed24h=${w.runsFailed}; workingNow=${w.workingNow}` +
        `; activeObjectives=${w.activeObjectives}; objectivesAtRisk=${w.objectivesAtRisk}` +
        `; budgetSpentPct=${w.spentPct}` +
        (w.outcome ? `; outcome="${w.outcome}"` : '') +
        (w.insights.length > 0 ? `; topInsight="${w.insights[0]!.headline}"` : ''),
    );
  }
  return lines.join('\n');
}
