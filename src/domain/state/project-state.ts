import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  type ContextManifestEntry,
  type DataClassification,
  type Freshness,
  type TenantContext,
} from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { agents, approvals, objectives, runs, tasks } from '@/db/schema';
import { type ContextItemForPrompt } from '@/orchestration/prompts';
import { type ClassificationVisibility, type ExclusionSummary, LIVE_ONLY, exclusionSummary, loadProjectClassification, resolveRecordClassification } from '@/domain/classification/classification';

/**
 * Project State context (O-15). Makes an employee aware of the workspace's
 * current OPERATIONAL state — what is done, in progress, blocked, who owns it,
 * and what is pending — drawn from Hub RECORDS (objectives, tasks, runs,
 * approvals), never inferred from documents.
 *
 * This is the documented context-package extension pattern (CONTEXT-PACKAGE.md)
 * applied to structured state instead of files: selectors + tenancy guard +
 * dedup + manifest mapping + panel labels. No schema change — every field is
 * derivable from existing tables. Retrieval, quotas, indexing, and the provider
 * layer are untouched.
 */

// Bounded, deterministic caps per group.
const MAX_BLOCKERS = 5;
const MAX_ACTIVE = 5;
const MAX_RECENT = 5;
const MAX_PENDING = 5;
const RESULT_SUMMARY_CHARS = 240; // outcomes are summarized, never full transcripts

/** I1 re-assertion for state reads that feed the prompt. */
function assertScoped(
  rows: ReadonlyArray<{ orgId: string; projectId: string }>,
  ctx: TenantContext,
  where: string,
): void {
  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error(`TENANT VIOLATION in ${where}`, {
        expectedProject: ctx.projectId,
        gotProject: r.projectId,
      });
      throw new TenantViolationError(
        `State record from project ${r.projectId} surfaced for ${ctx.projectId}`,
      );
    }
  }
}

export interface ObjectiveProgress {
  title: string;
  status: string;
  criteriaMet: number;
  criteriaTotal: number;
  tasksComplete: number;
  tasksTotal: number;
  /** Most recent objective or criterion update (ISO) — the Hub freshness basis. */
  sourceUpdatedAt: string | null;
}

/** Latest of a set of maybe-timestamps as ISO, or null. */
function latestIso(...values: Array<Date | string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const iso = v instanceof Date ? v.toISOString() : v;
    if (best == null || iso > best) best = iso;
  }
  return best;
}

export async function selectObjectiveProgress(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string | null,
): Promise<ObjectiveProgress | null> {
  if (!objectiveId) return null;
  const rows = await tx
    .select({
      title: objectives.title,
      status: objectives.status,
      successCriteria: objectives.successCriteria,
      updatedAt: objectives.updatedAt,
      orgId: objectives.orgId,
      projectId: objectives.projectId,
    })
    .from(objectives)
    .where(
      and(
        eq(objectives.id, objectiveId),
        eq(objectives.projectId, ctx.projectId),
        eq(objectives.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  assertScoped(rows, ctx, 'selectObjectiveProgress');
  const o = rows[0];
  if (!o) return null;

  const taskRows = await tx
    .select({
      status: tasks.status,
      updatedAt: tasks.updatedAt,
      orgId: tasks.orgId,
      projectId: tasks.projectId,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.objectiveId, objectiveId),
        eq(tasks.projectId, ctx.projectId),
        eq(tasks.orgId, ctx.orgId),
      ),
    );
  assertScoped(taskRows, ctx, 'selectObjectiveProgress.tasks');

  // Freshness of the objective's operational state: the most recent of the
  // objective row, any criterion verification, and any attached task update.
  const criterionVerified = o.successCriteria.map((c) => c.verifiedAt);
  const sourceUpdatedAt = latestIso(
    o.updatedAt,
    ...criterionVerified,
    ...taskRows.map((t) => t.updatedAt),
  );

  return {
    title: o.title,
    status: o.status,
    criteriaMet: o.successCriteria.filter((c) => c.status !== 'unmet').length,
    criteriaTotal: o.successCriteria.length,
    tasksComplete: taskRows.filter((t) => t.status === 'completed').length,
    tasksTotal: taskRows.length,
    sourceUpdatedAt,
  };
}

export interface StateTask {
  taskId: string;
  title: string;
  status: string;
  owner: string;
  objectiveRelation: 'this objective' | 'other objective' | 'unattached';
  detail: string | null; // blocker reason or outcome summary
  when: Date;
  /** HUB-009 — effective classification (for labelling when non-live outcomes are shown). */
  classification: DataClassification;
}

export interface ClassifiedTasks {
  blockers: StateTask[];
  active: StateTask[];
  recent: StateTask[];
  /** HUB-009 — demo/seed related tasks hidden by a live-only view (0 when includeNonLive or none). */
  excluded: ExclusionSummary;
}

/**
 * Classifies the workspace's tasks into blockers / active / recent, preferring
 * tasks attached to the selected objective and bounding each group. The task
 * being run is excluded. Owner is the latest run's primary employee.
 *
 * HUB-009 — visibility-aware: default LIVE_ONLY (a real run's Hub-state context stays live-only); with
 * `includeNonLive` the display caller also receives authorized demo/seed outcomes, each carrying its
 * effective classification. Live grouping/headline counts elsewhere are unaffected.
 */
export async function selectRelatedTasks(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string | null,
  excludeTaskId: string | null,
  visibility: ClassificationVisibility = LIVE_ONLY,
): Promise<ClassifiedTasks> {
  const taskRows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      objectiveId: tasks.objectiveId,
      updatedAt: tasks.updatedAt,
      createdAt: tasks.createdAt,
      orgId: tasks.orgId,
      projectId: tasks.projectId,
      classification: tasks.classification,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .orderBy(desc(tasks.updatedAt))
    .limit(100);
  assertScoped(taskRows, ctx, 'selectRelatedTasks');

  // HUB-009 — default LIVE_ONLY so a real run's Hub-state context never includes demo/seed outcomes; a
  // display caller passing includeNonLive additionally receives them (labelled). Headline counts unaffected.
  const projectClassification = await loadProjectClassification(tx, ctx.projectId);
  const withClass = taskRows
    .filter((t) => t.id !== excludeTaskId && t.status !== 'cancelled')
    .map((t) => ({ ...t, effective: resolveRecordClassification(t.classification, projectClassification).classification }));
  const relevant = withClass.filter((t) => visibility.includeNonLive || t.effective === 'live');
  const nonLive = withClass.filter((t) => t.effective !== 'live');
  const excluded = exclusionSummary({
    excludedDemo: nonLive.filter((t) => t.effective === 'demo').length,
    excludedSeed: nonLive.filter((t) => t.effective === 'seed').length,
  });
  const ids = relevant.map((t) => t.id);

  // Latest run per task → owner (primary agent) + result/error, in one pass.
  const runRows = ids.length
    ? await tx
        .select({
          taskId: runs.taskId,
          primaryAgentId: runs.primaryAgentId,
          consolidatedResult: runs.consolidatedResult,
          errorMessage: runs.errorMessage,
          startedAt: runs.startedAt,
          orgId: runs.orgId,
          projectId: runs.projectId,
        })
        .from(runs)
        .where(
          and(
            inArray(runs.taskId, ids),
            eq(runs.projectId, ctx.projectId),
            eq(runs.orgId, ctx.orgId),
          ),
        )
        .orderBy(desc(runs.startedAt))
    : [];
  assertScoped(runRows, ctx, 'selectRelatedTasks.runs');
  const latestRun = new Map<string, (typeof runRows)[number]>();
  for (const r of runRows) if (!latestRun.has(r.taskId)) latestRun.set(r.taskId, r);

  const agentIds = [...new Set([...latestRun.values()].map((r) => r.primaryAgentId).filter(Boolean))];
  const agentRows = agentIds.length
    ? await tx
        .select({ id: agents.id, name: agents.name, orgId: agents.orgId, projectId: agents.projectId })
        .from(agents)
        .where(
          and(
            inArray(agents.id, agentIds),
            eq(agents.projectId, ctx.projectId),
            eq(agents.orgId, ctx.orgId),
          ),
        )
    : [];
  assertScoped(agentRows, ctx, 'selectRelatedTasks.agents');
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));

  const toStateTask = (t: (typeof relevant)[number], detail: string | null): StateTask => {
    const run = latestRun.get(t.id);
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      owner: (run?.primaryAgentId && agentName.get(run.primaryAgentId)) || 'unassigned',
      objectiveRelation:
        t.objectiveId == null
          ? 'unattached'
          : t.objectiveId === objectiveId
            ? 'this objective'
            : 'other objective',
      detail,
      when: t.updatedAt ?? t.createdAt,
      classification: t.effective,
    };
  };

  // Prefer objective-attached within each group (stable: rows already ordered
  // by updatedAt desc, so a stable partition preserves recency).
  const preferObjective = (a: (typeof relevant)[number], b: (typeof relevant)[number]): number => {
    const av = a.objectiveId === objectiveId ? 0 : 1;
    const bv = b.objectiveId === objectiveId ? 0 : 1;
    return av - bv;
  };

  const blockers = relevant
    .filter((t) => t.status === 'failed' || t.status === 'awaiting_approval')
    .sort(preferObjective)
    .slice(0, MAX_BLOCKERS)
    .map((t) =>
      toStateTask(
        t,
        t.status === 'failed'
          ? latestRun.get(t.id)?.errorMessage ?? 'run failed'
          : 'awaiting human approval',
      ),
    );

  const active = relevant
    .filter((t) => t.status === 'running' || t.status === 'pending')
    .sort((a, b) => preferObjective(a, b) || (a.status === 'running' ? -1 : 1))
    .slice(0, MAX_ACTIVE)
    .map((t) => toStateTask(t, null));

  const recent = relevant
    .filter((t) => t.status === 'completed')
    .sort(preferObjective)
    .slice(0, MAX_RECENT)
    .map((t) => {
      const result = latestRun.get(t.id)?.consolidatedResult ?? null;
      const summary = result
        ? result.replace(/\s+/g, ' ').trim().slice(0, RESULT_SUMMARY_CHARS)
        : null;
      return toStateTask(t, summary);
    });

  return { blockers, active, recent, excluded };
}

export interface PendingReview {
  actionType: string;
  summary: string;
  when: Date;
}

export async function selectPendingReviews(
  tx: DbTx,
  ctx: TenantContext,
): Promise<PendingReview[]> {
  const rows = await tx
    .select({
      actionType: approvals.actionType,
      summary: approvals.summary,
      createdAt: approvals.createdAt,
      orgId: approvals.orgId,
      projectId: approvals.projectId,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.status, 'pending'),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(MAX_PENDING);
  assertScoped(rows, ctx, 'selectPendingReviews');
  return rows.map((r) => ({ actionType: r.actionType, summary: r.summary, when: r.createdAt }));
}

export interface ProjectStatePackage {
  /** The injected state block, or null when there is no state to report. */
  contextItem: ContextItemForPrompt | null;
  manifest: ContextManifestEntry[];
  /** Freshness of the Level-1 Hub state, for the O-17 comparison. */
  freshness: Freshness | null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Assembles the full project-state package: one structured text block for the
 * prompt plus a manifest of exactly which records were injected and why.
 * Tenant-scoped throughout; the current task is excluded from its own state.
 */
export async function assembleProjectState(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string | null,
  excludeTaskId: string | null,
): Promise<ProjectStatePackage> {
  const nowIso = new Date().toISOString();
  const [progress, related, pending] = await Promise.all([
    selectObjectiveProgress(tx, ctx, objectiveId),
    selectRelatedTasks(tx, ctx, objectiveId, excludeTaskId),
    selectPendingReviews(tx, ctx),
  ]);

  const manifest: ContextManifestEntry[] = [];

  // Hub-state freshness: the most recent of any relevant Hub update. High
  // confidence — these are first-class records with real update timestamps.
  const hubUpdatedAt = latestIso(
    progress?.sourceUpdatedAt ?? null,
    ...related.blockers.map((t) => t.when),
    ...related.active.map((t) => t.when),
    ...related.recent.map((t) => t.when),
    ...pending.map((p) => p.when),
  );
  const hubFreshness: Freshness = {
    observedAt: nowIso,
    sourceUpdatedAt: hubUpdatedAt ?? undefined,
    confidence: hubUpdatedAt ? 'high' : 'unknown',
    basis: hubUpdatedAt
      ? 'most recent objective / criterion / task update in the Hub'
      : 'no Hub update timestamp available',
  };

  const lines: string[] = [
    'CURRENT HUB STATE (structured records from the Hub, not inferred from documents):',
    hubUpdatedAt ? `Hub state last updated: ${hubUpdatedAt.slice(0, 10)} (confidence high).` : '',
    '',
  ];

  if (progress) {
    lines.push(
      `Objective: "${progress.title}" — ${progress.status} — ${progress.criteriaMet}/${progress.criteriaTotal} success criteria met — ${progress.tasksComplete}/${progress.tasksTotal} attached tasks complete.`,
      '',
    );
    manifest.push({
      source: 'objective_progress',
      label: progress.title,
      detail: `${progress.status} · ${progress.criteriaMet}/${progress.criteriaTotal} criteria · ${progress.tasksComplete}/${progress.tasksTotal} tasks`,
      freshness: progress.sourceUpdatedAt
        ? { sourceUpdatedAt: progress.sourceUpdatedAt, confidence: 'high' }
        : { confidence: 'unknown' },
    });
  }

  lines.push('Active work (in progress or not yet started):');
  if (related.active.length === 0) {
    lines.push('- none');
  } else {
    for (const t of related.active) {
      lines.push(`- [${t.status}] "${t.title}" — owner: ${t.owner} — ${t.objectiveRelation}`);
      manifest.push({ source: 'active_work', label: t.title, detail: `${t.status} · ${t.owner}` });
    }
  }
  lines.push('');

  lines.push('Blockers:');
  if (related.blockers.length === 0) {
    lines.push('- none');
  } else {
    for (const t of related.blockers) {
      lines.push(`- [${t.status}] "${t.title}" — owner: ${t.owner} — blocker: ${t.detail ?? 'unspecified'}`);
      manifest.push({ source: 'blocker', label: t.title, detail: `${t.status} · ${t.detail ?? ''}`.trim() });
    }
  }
  lines.push('');

  lines.push('Recent completed outcomes (most recent first):');
  if (related.recent.length === 0) {
    lines.push('- none');
  } else {
    for (const t of related.recent) {
      lines.push(
        `- "${t.title}" — completed ${ymd(t.when)} — owner: ${t.owner}` +
          (t.detail ? ` — result: ${t.detail}` : ''),
      );
      manifest.push({
        source: 'recent_outcome',
        label: t.title,
        detail: `completed ${ymd(t.when)} · ${t.owner}`,
      });
    }
  }
  lines.push('');

  lines.push('Pending reviews / approvals:');
  if (pending.length === 0) {
    lines.push('- none');
  } else {
    for (const p of pending) {
      lines.push(`- [${p.actionType}] ${p.summary} — awaiting approval`);
      manifest.push({ source: 'pending_review', label: p.summary, detail: p.actionType });
    }
  }

  // Nothing to say if there's no objective and no records at all.
  if (manifest.length === 0) {
    return { contextItem: null, manifest: [], freshness: null };
  }

  return {
    contextItem: {
      title: 'Project state (Hub records)',
      content: lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'),
      freshness: hubFreshness,
    },
    manifest,
    freshness: hubFreshness,
  };
}
