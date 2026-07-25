import 'server-only';
import { type ContextManifestEntry, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { type ContextItemForPrompt } from '@/orchestration/prompts';
import { buildTaskGraph } from './dependencies';

/**
 * Turns the bounded task-dependency neighborhood (O-18) into a Level-1 Hub
 * context block plus a manifest entry carrying graph metadata. Structured Hub
 * records — not inferred. The distinctions the model needs (blocked vs
 * independent vs no-data) are stated explicitly.
 */
export interface GraphContext {
  contextItem: ContextItemForPrompt | null;
  manifest: ContextManifestEntry[];
}

export async function assembleTaskGraph(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<GraphContext> {
  const g = await buildTaskGraph(tx, ctx, taskId);
  if (!g) return { contextItem: null, manifest: [] };

  // No edges at all → say so plainly, so the model distinguishes "independent
  // work" from "no dependency information available".
  if (g.edges.length === 0) {
    const content =
      'TASK DEPENDENCY GRAPH (structured Hub records):\n' +
      `Current task: "${g.root.title}" (${g.root.status}).\n` +
      'No dependency information available: this task has no recorded prerequisites or dependents. ' +
      'Treat it as independent work — do not assume hidden blockers.';
    return {
      contextItem: { title: 'Task dependency graph', content },
      manifest: [
        {
          source: 'task_graph',
          label: g.root.title,
          detail: 'no recorded dependencies',
          graph: { nodeCount: 1, edgeCount: 0, rootTask: g.root.title, cycle: false },
        },
      ],
    };
  }

  const list = (ns: { title: string; status: string }[]): string =>
    ns.length === 0 ? 'none' : ns.map((n) => `"${n.title}" (${n.status})`).join(', ');

  const lines: string[] = [
    'TASK DEPENDENCY GRAPH (structured Hub records — explicit relationships, not inferred):',
    `Current task: "${g.root.title}" (${g.root.status}).`,
  ];

  if (g.cycle) {
    lines.push(
      'Dependency cycle detected in this neighborhood. Traversal was bounded and stopped; ' +
        'do not attempt to order these tasks as a chain. Report the cycle and recommend breaking it.',
    );
  }

  lines.push(`Immediate prerequisites: ${list(g.prerequisites)}.`);
  lines.push(
    g.blockers.length > 0
      ? `Current blockers (incomplete prerequisites — this task is BLOCKED until they finish): ${list(g.blockers)}.`
      : 'Current blockers: none — all prerequisites are complete, so this task is not blocked by dependencies.',
  );
  lines.push(`Unlocked by completing this task: ${list(g.unlockedOnCompletion)}.`);
  lines.push(
    g.siblings.length > 0
      ? `Parallel work (shares a prerequisite with this task; NOT blocked by it): ${list(g.siblings)}.`
      : 'Parallel work: none identified.',
  );
  if (!g.cycle && g.criticalChain.length > 1) {
    lines.push(`Critical incomplete chain: ${g.criticalChain.map((t) => `"${t}"`).join(' → ')}.`);
  }
  lines.push(
    'When recommending next actions, respect this order: do not recommend work whose prerequisites are still incomplete.',
  );
  if (g.truncated) {
    lines.push('(Neighborhood truncated at the node limit; more distant dependencies exist.)');
  }

  return {
    contextItem: { title: 'Task dependency graph', content: lines.join('\n') },
    manifest: [
      {
        source: 'task_graph',
        label: g.root.title,
        detail:
          `${g.nodes.length} nodes · ${g.edges.length} edges` +
          (g.cycle ? ' · CYCLE' : '') +
          (g.blockers.length > 0 ? ` · ${g.blockers.length} blocking` : ''),
        graph: {
          nodeCount: g.nodes.length,
          edgeCount: g.edges.length,
          rootTask: g.root.title,
          cycle: g.cycle,
        },
      },
    ],
  };
}
