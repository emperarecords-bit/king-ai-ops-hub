import { and, eq, sql, inArray, type SQL, type Column } from 'drizzle-orm';
import {
  DATA_CLASSIFICATIONS,
  type DataClassification,
  type TenantContext,
} from '@/types/domain';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, decisions, objectives, projects, runs, tasks, workItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * HUB-009 — data classification model. A stored marker (`live | demo | seed`) distinguishes genuine
 * operating data from demonstration and fixture data so operator surfaces can default to live-only WITHOUT
 * ever deleting anything. This module is the single source of the classification RULES:
 *
 *  - Precedence: `seed > demo > live`. The EFFECTIVE classification of a record is the highest non-live
 *    value among its own stored classification and its project's; for an activity (a run), also its
 *    performing agent(s). A non-live project makes every child effectively non-live; a live project may
 *    still contain an explicitly demo/seed task/objective/agent/decision.
 *  - A live agent performing demo work produces demo ACTIVITY, but the agent record itself is NOT
 *    reclassified — classification describes the activity, not the performer.
 *  - History is hybrid: future runs/usage carry an IMMUTABLE snapshot resolved at creation; rows whose
 *    snapshot is null are resolved by legacy derivation from CURRENT parents and labelled `legacy-derived`,
 *    so append-only history is never rewritten yet future classification stays historically stable.
 *
 * Classification is NEVER inferred from titles, names, paths, or project keys in production runtime code.
 */

export type ClassificationProvenance = 'snapshot' | 'record' | 'project' | 'performer' | 'legacy-derived';

export interface EffectiveClassification {
  classification: DataClassification;
  /** Which input determined the value — for diagnostics and to distinguish snapshot from legacy-derived. */
  provenance: ClassificationProvenance;
}

const RANK: Record<DataClassification, number> = { live: 0, demo: 1, seed: 2 };

/** Ordinal for the `seed > demo > live` precedence (higher = more significant). */
export function classificationRank(c: DataClassification): number {
  return RANK[c];
}

export function isNonLive(c: DataClassification): boolean {
  return c !== 'live';
}

/**
 * Highest-precedence classification among the given sources (null/undefined → `live`). Sources are given
 * in tie-break priority order (earliest wins a tie). When the result is `live`, provenance is normalised to
 * `record` (the record's own baseline) rather than an arbitrary tie-winner.
 */
function dominant(
  entries: { source: ClassificationProvenance; value: DataClassification | null | undefined }[],
): EffectiveClassification {
  let best: EffectiveClassification = { classification: 'live', provenance: 'record' };
  let bestRank = -1;
  for (const e of entries) {
    const value = e.value ?? 'live';
    const rank = RANK[value];
    if (rank > bestRank) {
      bestRank = rank;
      best = { classification: value, provenance: e.source };
    }
  }
  return best.classification === 'live' ? { classification: 'live', provenance: 'record' } : best;
}

/** Effective classification of a durable record from its own value and its project's (project dominates ties). */
export function resolveRecordClassification(
  recordClassification: DataClassification | null | undefined,
  projectClassification: DataClassification | null | undefined,
): EffectiveClassification {
  return dominant([
    { source: 'project', value: projectClassification },
    { source: 'record', value: recordClassification },
  ]);
}

/**
 * Classification of an ACTIVITY (a run) computed at creation time from its project, its task, and its
 * performing agent(s). This is the value snapshotted onto the run. Project dominates ties, then the task,
 * then the performer — so `provenance` names why it is non-live.
 */
export function computeActivityClassification(inputs: {
  projectClassification: DataClassification | null | undefined;
  taskClassification: DataClassification | null | undefined;
  performerClassifications: (DataClassification | null | undefined)[];
}): EffectiveClassification {
  return dominant([
    { source: 'project', value: inputs.projectClassification },
    { source: 'record', value: inputs.taskClassification },
    ...inputs.performerClassifications.map((value) => ({ source: 'performer' as const, value })),
  ]);
}

/**
 * Effective classification of a RUN for reading: the immutable snapshot when present (`snapshot`), otherwise
 * derived from current parents and labelled `legacy-derived` (never faked as a snapshot).
 */
export function resolveRunClassification(
  snapshot: DataClassification | null | undefined,
  deriveInputs: {
    projectClassification: DataClassification | null | undefined;
    taskClassification: DataClassification | null | undefined;
    performerClassifications: (DataClassification | null | undefined)[];
  },
): EffectiveClassification {
  if (snapshot) return { classification: snapshot, provenance: 'snapshot' };
  return { classification: computeActivityClassification(deriveInputs).classification, provenance: 'legacy-derived' };
}

/**
 * Effective classification of a USAGE event for reading. A run-associated usage snapshot mirrors the run;
 * when the usage snapshot is null it inherits the run's snapshot (legacy-derived), and a run-less usage
 * event falls back to the project (legacy-derived). Never independently recomputed from mutable parents.
 */
export function resolveUsageClassification(
  usageSnapshot: DataClassification | null | undefined,
  inputs: {
    runSnapshot?: DataClassification | null;
    projectClassification: DataClassification | null | undefined;
  },
): EffectiveClassification {
  if (usageSnapshot) return { classification: usageSnapshot, provenance: 'snapshot' };
  if (inputs.runSnapshot) return { classification: inputs.runSnapshot, provenance: 'legacy-derived' };
  return { classification: inputs.projectClassification ?? 'live', provenance: 'legacy-derived' };
}

// ---------------------------------------------------------------------------
// Surface visibility contract (Gate 3B) — one shared way for every operator-facing read to default to
// live-only and expose an explicit opt-in. Never let a page invent its own filtering rule.
// ---------------------------------------------------------------------------

export interface ClassificationVisibility {
  readonly includeNonLive: boolean;
}
/** The mandatory default for every surface read. */
export const LIVE_ONLY: ClassificationVisibility = { includeNonLive: false };

/**
 * Parse the page-scoped `?includeNonLive=1` query param. The ONLY enabled state is a single scalar value
 * exactly equal to "1". Everything else is OFF — missing, empty, "0", "true", whitespace, AND any repeated/
 * array value (e.g. `?includeNonLive=0&includeNonLive=1`). Inclusion is never enabled by picking one element
 * out of a repeated parameter. This is the single shared parser used by every page.
 */
export function visibilityFromParam(value: string | string[] | undefined): ClassificationVisibility {
  return { includeNonLive: value === '1' };
}

/** A project's own stored classification (reads are single-project-scoped, so this is constant per read). */
export async function loadProjectClassification(tx: DbTx, projectId: string): Promise<DataClassification> {
  return (await tx.select({ c: projects.classification }).from(projects).where(eq(projects.id, projectId)).limit(1))[0]?.c ?? 'live';
}

/**
 * WHERE condition for a DURABLE-record read already scoped to ONE project. Because effective classification
 * = the most-significant of {project, record}, and the project is constant per read:
 *   - includeNonLive → no classification filter (undefined);
 *   - live-only in a NON-live project → nothing is effectively live (`false`);
 *   - live-only in a live project → keep only `record.classification = 'live'`.
 */
export function liveOnlyDurable(column: Column, projectClassification: DataClassification, visibility: ClassificationVisibility): SQL | undefined {
  if (visibility.includeNonLive) return undefined;
  if (projectClassification !== 'live') return sql`false`;
  return eq(column, 'live');
}

export interface ClassifiedItem<T> {
  item: T;
  effective: EffectiveClassification;
}
export interface ClassifiedPartition<T> {
  visible: ClassifiedItem<T>[];
  excludedDemo: number;
  excludedSeed: number;
}
/** Split already-classified rows into what a given visibility shows, plus the demo/seed counts it hid. */
export function partitionByEffective<T>(rows: ClassifiedItem<T>[], visibility: ClassificationVisibility): ClassifiedPartition<T> {
  let excludedDemo = 0;
  let excludedSeed = 0;
  const visible: ClassifiedItem<T>[] = [];
  for (const r of rows) {
    if (visibility.includeNonLive || r.effective.classification === 'live') visible.push(r);
    else if (r.effective.classification === 'demo') excludedDemo += 1;
    else excludedSeed += 1;
  }
  return { visible, excludedDemo, excludedSeed };
}

/** A discoverable exclusion note payload. `total === 0` ⇒ render nothing (no misleading "0 excluded"). */
export interface ExclusionSummary {
  demo: number;
  seed: number;
  total: number;
}
export function exclusionSummary(p: { excludedDemo: number; excludedSeed: number }): ExclusionSummary {
  return { demo: p.excludedDemo, seed: p.excludedSeed, total: p.excludedDemo + p.excludedSeed };
}
/** Human copy for an exclusion note, or null when there is nothing excluded. */
export function exclusionNote(s: ExclusionSummary): string | null {
  if (s.total <= 0) return null;
  const parts: string[] = [];
  if (s.demo > 0) parts.push(`${s.demo} demo`);
  if (s.seed > 0) parts.push(`${s.seed} seed`);
  return `${parts.join(' + ')} record${s.total === 1 ? '' : 's'} excluded`;
}

/** The visible label for one non-live row (page display), or null for a live row. */
export function classificationLabel(c: DataClassification): 'Demo' | 'Seed' | null {
  return c === 'demo' ? 'Demo' : c === 'seed' ? 'Seed' : null;
}

/**
 * Build the page-scoped visibility toggle href. Preserves EVERY other query parameter; turning on sets
 * `includeNonLive=1`; turning off removes ONLY that parameter. Pure so it is unit-testable.
 */
export function visibilityToggleHref(
  pathname: string,
  searchParams: Record<string, string | string[] | undefined>,
  turnOn: boolean,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (k === 'includeNonLive') continue; // we own this parameter
    if (typeof v === 'string') sp.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === 'string') sp.set(k, v[0]);
  }
  if (turnOn) sp.set('includeNonLive', '1');
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Resolve the NON-NULL classification to snapshot on a NEW usage event at creation time. Every future
 * usage event gets a stable snapshot — the DB `usage_events_classification_guard` trigger forbids a null.
 * Explicit policies (Gate 3A correction):
 *  - Usage attached to a SNAPSHOTTED run → copies the run's exact value.
 *  - Usage attached to a LEGACY (null-snapshot) run → resolves that run's effective classification NOW
 *    from its current parents and stores it, WITHOUT updating the run (its snapshot stays null/immutable).
 *  - Run-LESS usage → snapshots the current project classification.
 * All lookups are workspace-scoped, so legacy resolution never reads another workspace's parents.
 */
export async function classifyUsageAtInsert(
  tx: DbTx,
  ctx: Pick<TenantContext, 'orgId' | 'projectId'>,
  runId: string | null,
): Promise<DataClassification> {
  const projectClassification = async (): Promise<DataClassification> =>
    (await tx.select({ c: projects.classification }).from(projects).where(eq(projects.id, ctx.projectId)).limit(1))[0]?.c ?? 'live';

  if (!runId) return projectClassification(); // run-less → project snapshot

  const run = (
    await tx
      .select({ c: runs.classification, taskId: runs.taskId, primary: runs.primaryAgentId, reviewer: runs.reviewerAgentId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId), eq(runs.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!run) return projectClassification(); // defensive: run not visible in this workspace
  if (run.c) return run.c; // snapshotted run → copy exact value

  // Legacy null-snapshot run → resolve its effective classification from CURRENT parents (workspace-scoped).
  const project = await projectClassification();
  const task = run.taskId
    ? (await tx.select({ c: tasks.classification }).from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.projectId, ctx.projectId))).limit(1))[0]?.c ?? null
    : null;
  const agentIds = [run.primary, run.reviewer].filter((x): x is string => !!x);
  const agentRows = agentIds.length
    ? await tx.select({ c: agents.classification }).from(agents).where(and(inArray(agents.id, agentIds), eq(agents.projectId, ctx.projectId)))
    : [];
  return computeActivityClassification({
    projectClassification: project,
    taskClassification: task,
    performerClassifications: agentRows.map((a) => a.c),
  }).classification;
}

// ---------------------------------------------------------------------------
// Audited, entity-allowlisted, admin-only classification mutation.
// ---------------------------------------------------------------------------

/** The ONLY entity types whose stored classification may be changed. Runs/usage carry immutable snapshots;
 *  run_steps/messages inherit their run — none is directly classifiable. */
export const CLASSIFIABLE_ENTITY_TYPES = ['project', 'task', 'objective', 'work_item', 'agent', 'decision'] as const;
export type ClassifiableEntityType = (typeof CLASSIFIABLE_ENTITY_TYPES)[number];

export function isClassifiableEntityType(t: string): t is ClassifiableEntityType {
  return (CLASSIFIABLE_ENTITY_TYPES as readonly string[]).includes(t);
}

interface Located {
  current: DataClassification;
  apply: (to: DataClassification) => Promise<void>;
}

/** Locate the entity strictly within the caller's workspace; returns null for a cross-workspace or unknown id. */
async function locate(
  tx: DbTx,
  ctx: TenantContext,
  entityType: ClassifiableEntityType,
  entityId: string,
): Promise<Located | null> {
  const inWorkspace = (projectId: string | null | undefined) => projectId === ctx.projectId;
  switch (entityType) {
    case 'project': {
      const r = (
        await tx.select({ c: projects.classification }).from(projects).where(and(eq(projects.id, entityId), eq(projects.orgId, ctx.orgId))).limit(1)
      )[0];
      // A project entity must BE the caller's workspace — you classify the workspace you operate in.
      if (!r || entityId !== ctx.projectId) return null;
      return {
        current: r.c,
        apply: async (to) => {
          await tx.update(projects).set({ classification: to, updatedAt: new Date() }).where(eq(projects.id, entityId));
        },
      };
    }
    case 'task': {
      const r = (
        await tx.select({ c: tasks.classification, p: tasks.projectId }).from(tasks).where(and(eq(tasks.id, entityId), eq(tasks.orgId, ctx.orgId))).limit(1)
      )[0];
      if (!r || !inWorkspace(r.p)) return null;
      return { current: r.c, apply: async (to) => { await tx.update(tasks).set({ classification: to, updatedAt: new Date() }).where(eq(tasks.id, entityId)); } };
    }
    case 'objective': {
      const r = (
        await tx.select({ c: objectives.classification, p: objectives.projectId }).from(objectives).where(and(eq(objectives.id, entityId), eq(objectives.orgId, ctx.orgId))).limit(1)
      )[0];
      if (!r || !inWorkspace(r.p)) return null;
      return { current: r.c, apply: async (to) => { await tx.update(objectives).set({ classification: to, updatedAt: new Date() }).where(eq(objectives.id, entityId)); } };
    }
    case 'work_item': {
      const r = (
        await tx.select({ c: workItems.classification, p: workItems.projectId }).from(workItems).where(and(eq(workItems.id, entityId), eq(workItems.orgId, ctx.orgId))).limit(1)
      )[0];
      if (!r || !inWorkspace(r.p)) return null;
      return { current: r.c, apply: async (to) => { await tx.update(workItems).set({ classification: to, updatedAt: new Date() }).where(eq(workItems.id, entityId)); } };
    }
    case 'agent': {
      const r = (
        await tx.select({ c: agents.classification, p: agents.projectId }).from(agents).where(and(eq(agents.id, entityId), eq(agents.orgId, ctx.orgId))).limit(1)
      )[0];
      if (!r || !inWorkspace(r.p)) return null;
      return { current: r.c, apply: async (to) => { await tx.update(agents).set({ classification: to, updatedAt: new Date() }).where(eq(agents.id, entityId)); } };
    }
    case 'decision': {
      const r = (
        await tx.select({ c: decisions.classification, p: decisions.projectId }).from(decisions).where(and(eq(decisions.id, entityId), eq(decisions.orgId, ctx.orgId))).limit(1)
      )[0];
      if (!r || !inWorkspace(r.p)) return null;
      return { current: r.c, apply: async (to) => { await tx.update(decisions).set({ classification: to, updatedAt: new Date() }).where(eq(decisions.id, entityId)); } };
    }
    default:
      return null;
  }
}

/**
 * Reclassify one durable record. Admin-only, entity-allowlisted, workspace-scoped, transactional with its
 * audit entry. Reversal is the same call with the prior value. An unchanged request is an idempotent no-op
 * that writes NOTHING (no row update, no audit event). Never a generic table updater.
 */
export async function setRecordClassification(
  tx: DbTx,
  ctx: TenantContext,
  input: { entityType: string; entityId: string; to: DataClassification; reason: string },
): Promise<boolean> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only a workspace admin can classify records.');
  }
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError(['A reason is required to change a record classification.']);
  if (!(DATA_CLASSIFICATIONS as readonly string[]).includes(input.to)) {
    throw new ValidationError([`Invalid classification: ${input.to}`]);
  }
  if (!isClassifiableEntityType(input.entityType)) {
    throw new ValidationError([`Entity type is not classifiable: ${input.entityType}`]);
  }

  const located = await locate(tx, ctx, input.entityType, input.entityId);
  if (!located) throw new NotFoundError('Record'); // unknown id OR cross-workspace → rejected

  if (located.current === input.to) return false; // idempotent no-op: no write, no audit event

  await located.apply(input.to);
  await writeAudit(tx, ctx, {
    action: 'record.classification_changed',
    entityType: input.entityType,
    entityId: input.entityId,
    detail: { entityType: input.entityType, entityId: input.entityId, from: located.current, to: input.to, reason },
  });
  return true;
}
