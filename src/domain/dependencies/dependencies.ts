import 'server-only';
import { and, eq, inArray, or } from 'drizzle-orm';
import { type DependencyKind, type TenantContext } from '@/types/domain';
import { AppError, ConflictError, NotFoundError, TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { taskDependencies, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { loadProjectClassification, resolveRecordClassification } from '@/domain/classification/classification';

/**
 * Task dependency graph (O-18): explicit, Hub-recorded workflow structure —
 * never inferred by a model. One canonical directed edge per row
 * (prerequisite → dependent). The bounded-neighborhood traversal and cycle
 * detection here feed a context source; they do not change retrieval, context
 * assembly, authority, or freshness.
 */

const MAX_DEPTH = 2;
const MAX_NODES = 15;

/** I1 re-assertion for graph reads that feed the prompt. */
function assertScoped(
  rows: ReadonlyArray<{ orgId: string; projectId: string }>,
  ctx: TenantContext,
  where: string,
): void {
  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error(`TENANT VIOLATION in ${where}`, { expected: ctx.projectId, got: r.projectId });
      throw new TenantViolationError(`Dependency from project ${r.projectId} for ${ctx.projectId}`);
    }
  }
}

async function requireTask(tx: DbTx, ctx: TenantContext, taskId: string) {
  const rows = await tx
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, classification: tasks.classification })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .limit(1);
  const t = rows[0];
  if (!t) throw new NotFoundError('Task');
  return t;
}

/**
 * Records "dependent depends on prerequisite" (prerequisite must finish first).
 * Both tasks must be in this workspace. Refuses a self-edge and refuses an edge
 * that would create a cycle — determined by a bounded reachability check, not a
 * model.
 */
export async function addDependency(
  tx: DbTx,
  ctx: TenantContext,
  args: { dependentTaskId: string; prerequisiteTaskId: string; kind?: DependencyKind },
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can edit dependencies.');
  }
  if (args.dependentTaskId === args.prerequisiteTaskId) {
    throw new ConflictError('A task cannot depend on itself.');
  }
  const dependent = await requireTask(tx, ctx, args.dependentTaskId);
  const prerequisite = await requireTask(tx, ctx, args.prerequisiteTaskId);

  // HUB-009: a LIVE task must not depend on a non-live (demo/seed) task — that would let demonstration or
  // fixture work gate real execution behavior. This is enforced server-side regardless of any client filter,
  // so a manually-submitted non-live prerequisite id is still rejected. (A non-live task MAY depend on a live
  // task: the live prerequisite's behavior is unaffected by having a non-live dependent.)
  const projectClassification = await loadProjectClassification(tx, ctx.projectId);
  const dependentClass = resolveRecordClassification(dependent.classification, projectClassification).classification;
  const prerequisiteClass = resolveRecordClassification(prerequisite.classification, projectClassification).classification;
  if (dependentClass === 'live' && prerequisiteClass !== 'live') {
    throw new ConflictError(`A live task cannot depend on a ${prerequisiteClass} task.`);
  }

  // Would adding prereq→dependent close a cycle? Yes iff the DEPENDENT can
  // already reach the PREREQUISITE via forward edges (then prereq→dependent→…
  // →prereq). Bounded forward walk from dependent, looking for prerequisite.
  if (await reaches(tx, ctx, args.dependentTaskId, args.prerequisiteTaskId)) {
    throw new ConflictError(
      'That dependency would create a cycle: this task is already a prerequisite of that one.',
    );
  }

  await tx
    .insert(taskDependencies)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      prerequisiteTaskId: args.prerequisiteTaskId,
      dependentTaskId: args.dependentTaskId,
      kind: args.kind ?? 'prerequisite',
      createdBy: ctx.userId,
    })
    .onConflictDoNothing();

  await writeAudit(tx, ctx, {
    action: 'dependency.added',
    entityType: 'task',
    entityId: args.dependentTaskId,
    detail: { prerequisite: prerequisite.title, dependent: dependent.title, kind: args.kind ?? 'prerequisite' },
  });
}

export async function removeDependency(
  tx: DbTx,
  ctx: TenantContext,
  args: { dependentTaskId: string; prerequisiteTaskId: string },
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can edit dependencies.');
  }
  const deleted = await tx
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.projectId, ctx.projectId),
        eq(taskDependencies.orgId, ctx.orgId),
        eq(taskDependencies.prerequisiteTaskId, args.prerequisiteTaskId),
        eq(taskDependencies.dependentTaskId, args.dependentTaskId),
      ),
    )
    .returning({ id: taskDependencies.id });
  if (deleted.length === 0) throw new NotFoundError('Dependency');

  await writeAudit(tx, ctx, {
    action: 'dependency.removed',
    entityType: 'task',
    entityId: args.dependentTaskId,
    detail: { prerequisiteTaskId: args.prerequisiteTaskId },
  });
}

/** Bounded forward-reachability: is `target` reachable from `start` following
 *  prerequisite→dependent edges within MAX_NODES visited? Guards against cycles
 *  by tracking visited. */
async function reaches(
  tx: DbTx,
  ctx: TenantContext,
  start: string,
  target: string,
): Promise<boolean> {
  const visited = new Set<string>([start]);
  let frontier = [start];
  let guard = 0;
  while (frontier.length > 0 && guard < 1000) {
    guard += 1;
    const rows = await tx
      .select({
        dependentTaskId: taskDependencies.dependentTaskId,
        orgId: taskDependencies.orgId,
        projectId: taskDependencies.projectId,
      })
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.projectId, ctx.projectId),
          eq(taskDependencies.orgId, ctx.orgId),
          inArray(taskDependencies.prerequisiteTaskId, frontier),
        ),
      );
    assertScoped(rows, ctx, 'reaches');
    const next: string[] = [];
    for (const r of rows) {
      if (r.dependentTaskId === target) return true;
      if (!visited.has(r.dependentTaskId)) {
        visited.add(r.dependentTaskId);
        next.push(r.dependentTaskId);
      }
    }
    frontier = next;
  }
  return false;
}

export interface GraphNode {
  taskId: string;
  title: string;
  status: string;
}
export interface GraphEdge {
  prerequisiteTaskId: string;
  dependentTaskId: string;
}

export interface TaskGraph {
  root: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Direct prerequisites of the root. */
  prerequisites: GraphNode[];
  /** Direct dependents of the root. */
  dependents: GraphNode[];
  /** Root's prerequisites that are not yet complete (the current blockers). */
  blockers: GraphNode[];
  /** Dependents whose ONLY incomplete prerequisite is the root — unlocked on completion. */
  unlockedOnCompletion: GraphNode[];
  /** Tasks sharing a prerequisite with the root (parallel work), not blocking it. */
  siblings: GraphNode[];
  /** Longest incomplete prerequisite chain ending at the root (titles). */
  criticalChain: string[];
  /** True if a cycle touches the neighborhood; traversal is bounded regardless. */
  cycle: boolean;
  truncated: boolean;
}

function isComplete(status: string): boolean {
  return status === 'completed';
}

/**
 * Builds the bounded dependency neighborhood around a task: direct parents,
 * direct children, and siblings, to depth 2 / 15 nodes. Cycles are detected and
 * reported, never recursed into. Tenant-scoped with I1 re-assertion.
 */
export async function buildTaskGraph(
  tx: DbTx,
  ctx: TenantContext,
  rootTaskId: string,
): Promise<TaskGraph | null> {
  const rootRows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      orgId: tasks.orgId,
      projectId: tasks.projectId,
    })
    .from(tasks)
    .where(and(eq(tasks.id, rootTaskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .limit(1);
  assertScoped(rootRows, ctx, 'buildTaskGraph.root');
  const rootRow = rootRows[0];
  if (!rootRow) return null;

  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncated = false;
  let cycle = false;

  const addNode = (n: GraphNode): boolean => {
    if (nodeMap.has(n.taskId)) return true;
    if (nodeMap.size >= MAX_NODES) {
      truncated = true;
      return false;
    }
    nodeMap.set(n.taskId, n);
    return true;
  };
  const addEdge = (e: GraphEdge): void => {
    const k = `${e.prerequisiteTaskId}->${e.dependentTaskId}`;
    if (!edgeSet.has(k)) {
      edgeSet.add(k);
      edges.push(e);
    }
  };

  addNode({ taskId: rootRow.id, title: rootRow.title, status: rootRow.status });

  // BFS out to MAX_DEPTH over BOTH directions. Because we track visited nodes,
  // a cycle can only add a back-edge, which we detect (edge to an already-known
  // ancestor) and flag rather than following forever.
  let frontier = [rootRow.id];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const rows = await tx
      .select({
        prerequisiteTaskId: taskDependencies.prerequisiteTaskId,
        dependentTaskId: taskDependencies.dependentTaskId,
        orgId: taskDependencies.orgId,
        projectId: taskDependencies.projectId,
      })
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.projectId, ctx.projectId),
          eq(taskDependencies.orgId, ctx.orgId),
          or(
            inArray(taskDependencies.dependentTaskId, frontier),
            inArray(taskDependencies.prerequisiteTaskId, frontier),
          ),
        ),
      );
    assertScoped(rows, ctx, 'buildTaskGraph.edges');

    const neighborIds = new Set<string>();
    for (const r of rows) {
      addEdge({ prerequisiteTaskId: r.prerequisiteTaskId, dependentTaskId: r.dependentTaskId });
      neighborIds.add(r.prerequisiteTaskId);
      neighborIds.add(r.dependentTaskId);
    }
    // Siblings: tasks that share a prerequisite with a frontier node.
    const frontierPrereqs = edges
      .filter((e) => frontier.includes(e.dependentTaskId))
      .map((e) => e.prerequisiteTaskId);
    if (frontierPrereqs.length > 0) {
      const sibRows = await tx
        .select({
          dependentTaskId: taskDependencies.dependentTaskId,
          orgId: taskDependencies.orgId,
          projectId: taskDependencies.projectId,
        })
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.projectId, ctx.projectId),
            eq(taskDependencies.orgId, ctx.orgId),
            inArray(taskDependencies.prerequisiteTaskId, frontierPrereqs),
          ),
        );
      assertScoped(sibRows, ctx, 'buildTaskGraph.siblings');
      for (const r of sibRows) neighborIds.add(r.dependentTaskId);
    }

    const toFetch = [...neighborIds].filter((id) => !nodeMap.has(id));
    if (toFetch.length > 0) {
      const taskRows = await tx
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          orgId: tasks.orgId,
          projectId: tasks.projectId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, ctx.projectId),
            eq(tasks.orgId, ctx.orgId),
            inArray(tasks.id, toFetch),
          ),
        );
      assertScoped(taskRows, ctx, 'buildTaskGraph.nodes');
      for (const t of taskRows) addNode({ taskId: t.id, title: t.title, status: t.status });
    }

    frontier = [...neighborIds].filter((id) => nodeMap.has(id));
  }

  // Cycle detection over the collected edges (Kahn's algorithm: leftover nodes
  // after removing all in-degree-0 nodes lie on a cycle).
  cycle = hasCycle(
    [...nodeMap.keys()],
    edges.map((e) => [e.prerequisiteTaskId, e.dependentTaskId] as const),
  );

  const node = (id: string): GraphNode | undefined => nodeMap.get(id);
  const prerequisites = edges
    .filter((e) => e.dependentTaskId === rootRow.id)
    .map((e) => node(e.prerequisiteTaskId))
    .filter((n): n is GraphNode => !!n);
  const dependents = edges
    .filter((e) => e.prerequisiteTaskId === rootRow.id)
    .map((e) => node(e.dependentTaskId))
    .filter((n): n is GraphNode => !!n);
  const blockers = prerequisites.filter((n) => !isComplete(n.status));

  // A dependent is unlocked on completion iff the root is its only incomplete
  // prerequisite (within the neighborhood we know about).
  const unlockedOnCompletion = dependents.filter((dep) => {
    const others = edges
      .filter((e) => e.dependentTaskId === dep.taskId && e.prerequisiteTaskId !== rootRow.id)
      .map((e) => node(e.prerequisiteTaskId))
      .filter((n): n is GraphNode => !!n);
    return others.every((n) => isComplete(n.status));
  });

  const rootPrereqIds = new Set(prerequisites.map((n) => n.taskId));
  const siblings = edges
    .filter((e) => rootPrereqIds.has(e.prerequisiteTaskId) && e.dependentTaskId !== rootRow.id)
    .map((e) => node(e.dependentTaskId))
    .filter((n): n is GraphNode => !!n);

  const criticalChain = cycle
    ? []
    : longestIncompletePrereqChain(rootRow.id, nodeMap, edges).map((id) => node(id)?.title ?? id);

  return {
    root: { taskId: rootRow.id, title: rootRow.title, status: rootRow.status },
    nodes: [...nodeMap.values()],
    edges,
    prerequisites,
    dependents,
    blockers,
    unlockedOnCompletion,
    siblings: dedupeNodes(siblings),
    criticalChain,
    cycle,
    truncated,
  };
}

function dedupeNodes(ns: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return ns.filter((n) => (seen.has(n.taskId) ? false : (seen.add(n.taskId), true)));
}

/** Kahn's algorithm cycle check over the given node ids and directed edges. */
export function hasCycle(nodeIds: string[], edges: ReadonlyArray<readonly [string, string]>): boolean {
  const indeg = new Map<string, number>(nodeIds.map((n) => [n, 0]));
  const out = new Map<string, string[]>(nodeIds.map((n) => [n, []]));
  for (const [from, to] of edges) {
    if (!indeg.has(to) || !out.has(from)) continue; // edge to outside the set
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
    out.get(from)!.push(to);
  }
  const queue = nodeIds.filter((n) => (indeg.get(n) ?? 0) === 0);
  let removed = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    removed += 1;
    for (const m of out.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if ((indeg.get(m) ?? 0) === 0) queue.push(m);
    }
  }
  return removed < nodeIds.length;
}

/** Longest chain of INCOMPLETE prerequisites ending at root (by node count). */
function longestIncompletePrereqChain(
  rootId: string,
  nodeMap: Map<string, GraphNode>,
  edges: GraphEdge[],
): string[] {
  const prereqsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!prereqsOf.has(e.dependentTaskId)) prereqsOf.set(e.dependentTaskId, []);
    prereqsOf.get(e.dependentTaskId)!.push(e.prerequisiteTaskId);
  }
  const memo = new Map<string, string[]>();
  const walk = (id: string, seen: Set<string>): string[] => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return [id]; // cycle guard
    const next = new Set(seen).add(id);
    let best: string[] = [];
    for (const p of prereqsOf.get(id) ?? []) {
      const pn = nodeMap.get(p);
      if (!pn || isComplete(pn.status)) continue;
      const chain = walk(p, next);
      if (chain.length > best.length) best = chain;
    }
    const result = [...best, id];
    memo.set(id, result);
    return result;
  };
  const chain = walk(rootId, new Set());
  // Only meaningful if it has more than the root itself.
  return chain.length > 1 ? chain : [];
}

export interface DependencyRow {
  prerequisiteTaskId: string;
  prerequisiteTitle: string;
  prerequisiteStatus: string;
  dependentTaskId: string;
  dependentTitle: string;
  dependentStatus: string;
}

/** Direct edges touching a task, for the management UI. */
export async function listDirectDependencies(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<{ prerequisites: DependencyRow[]; dependents: DependencyRow[] }> {
  const g = await buildTaskGraph(tx, ctx, taskId);
  if (!g) return { prerequisites: [], dependents: [] };
  const toRow = (prereq: GraphNode, dep: GraphNode): DependencyRow => ({
    prerequisiteTaskId: prereq.taskId,
    prerequisiteTitle: prereq.title,
    prerequisiteStatus: prereq.status,
    dependentTaskId: dep.taskId,
    dependentTitle: dep.title,
    dependentStatus: dep.status,
  });
  return {
    prerequisites: g.prerequisites.map((p) => toRow(p, g.root)),
    dependents: g.dependents.map((d) => toRow(g.root, d)),
  };
}
