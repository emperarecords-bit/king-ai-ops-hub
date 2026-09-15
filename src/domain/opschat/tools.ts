import 'server-only';
import { type TenantContext } from '@/types/domain';
import { type ToolSpec, type ToolRunner } from '@/types/provider';
import { withTenant } from '@/db/tenant';
import { type ProjectAccessRecord } from '@/db/system';
import { listObjectives } from '@/domain/objectives/objectives';
import { assessWorkspaceHealth } from '@/domain/health/health';
import { listTasks, getTask, listRuns, listRunSteps } from '@/domain/tasks/tasks';
import { openQuestionsForOwner, type OpenOwnerQuestion } from '@/domain/questions/questions';
import { listApprovalsForQueue, getApprovalDetail, type QueueApprovalRow } from '@/domain/approvals/approvals';

/**
 * Ops Chat tool layer (v2 + v2.1). The model may call these to fetch deeper
 * detail on demand (READS run instantly through the RLS boundary) and to PROPOSE
 * an action — answering an owner-question or deciding a pending approval. Propose
 * tools NEVER write: they validate and record a proposal that the route surfaces
 * for the owner to confirm; the write happens only in the confirm endpoint, which
 * re-runs the same governed path (answerOwnerQuestion / decideApproval).
 *
 * Multiple proposals per turn are supported (e.g. "approve all three"): each is
 * surfaced as its own confirm card.
 */

export type OpsChatProposal =
  | {
      readonly kind: 'answer_question';
      readonly questionId: string;
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly question: string;
      readonly answer: string;
    }
  | {
      readonly kind: 'decide_approval';
      readonly approvalId: string;
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly summary: string;
      readonly decision: 'approved' | 'rejected';
      readonly note: string;
    };

export interface OpsChatToolset {
  readonly tools: readonly ToolSpec[];
  readonly runTool: ToolRunner;
  /** Proposals recorded during this turn (may be several), for the owner to confirm. */
  getProposals(): readonly OpsChatProposal[];
}

interface AuthScope {
  readonly userId: string;
  readonly projects: readonly ProjectAccessRecord[];
  readonly orgRoles: ReadonlyMap<string, TenantContext['orgRole']>;
}

const MET = new Set(['met', 'waived']);

function argStr(input: unknown, key: string): string {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v.trim();
  }
  return '';
}
function argBool(input: unknown, key: string): boolean {
  return Boolean(input && typeof input === 'object' && (input as Record<string, unknown>)[key] === true);
}

function resolveProject(projects: readonly ProjectAccessRecord[], ref: string): ProjectAccessRecord | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  return (
    projects.find((p) => p.key.toLowerCase() === r) ??
    projects.find((p) => p.name.toLowerCase() === r) ??
    projects.find((p) => p.name.toLowerCase().includes(r) || r.includes(p.name.toLowerCase())) ??
    null
  );
}

function ctxFor(auth: AuthScope, p: ProjectAccessRecord): TenantContext {
  return {
    userId: auth.userId,
    orgId: p.orgId,
    projectId: p.projectId,
    orgRole: auth.orgRoles.get(p.orgId) ?? 'member',
    projectRole: p.projectRole,
  };
}

/** Pending approvals across the workspaces the caller ADMINISTERS, each tagged with its project. */
async function pendingApprovals(auth: AuthScope): Promise<Array<{ project: ProjectAccessRecord; row: QueueApprovalRow }>> {
  const out: Array<{ project: ProjectAccessRecord; row: QueueApprovalRow }> = [];
  for (const p of auth.projects.filter((x) => x.projectRole === 'admin')) {
    const ctx = ctxFor(auth, p);
    const rows = await withTenant(ctx, (tx) => listApprovalsForQueue(tx, ctx));
    for (const row of rows) if (row.status === 'pending') out.push({ project: p, row });
  }
  return out;
}

export const OPS_CHAT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_objective_criteria',
    description:
      "Get a workspace's objective, its success criteria (each with target and met/unmet status), and what is blocking the unmet ones. Use for 'what are the criteria?', 'why isn't it done?', 'what would finish it?'.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        objective: { type: 'string', description: 'Objective title or id. Omit to use the active objective.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'list_objectives',
    description: "List a workspace's objectives with status and criteria-met counts.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks in a workspace. Set open_only true to see only pending/running/awaiting-approval tasks.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, open_only: { type: 'boolean' } },
      required: ['project'],
    },
  },
  {
    name: 'get_task_detail',
    description:
      "Get a task's detail and its latest run outcome — including the failure reason and the failing step when it failed. Use to explain why a task or run failed.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, task: { type: 'string', description: 'Task title or id.' } },
      required: ['project', 'task'],
    },
  },
  {
    name: 'list_open_questions',
    description:
      'List open owner-questions (optionally filtered to one workspace), each with its id. Call this to get a questionId before proposing an answer.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Optional workspace name or key to filter by.' } },
      required: [],
    },
  },
  {
    name: 'list_pending_approvals',
    description:
      'List decisions waiting on the owner (pending approvals), optionally filtered to one workspace. Each has an id, the workspace, and a summary of the proposed action. Call this to get an approvalId before proposing a decision.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Optional workspace name or key to filter by.' } },
      required: [],
    },
  },
  {
    name: 'get_approval_detail',
    description: 'Get the full detail of one pending approval — the proposed action, its summary, and originating task.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        approvalId: { type: 'string' },
      },
      required: ['project', 'approvalId'],
    },
  },
  {
    name: 'propose_answer_question',
    description:
      'Prepare an answer to an owner-question FOR THE OWNER TO CONFIRM. Does NOT record anything — it surfaces a confirmation card the owner must approve. Get the questionId from list_open_questions first, and confirm the wording with the owner. To answer several duplicates, call this once per question.',
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        answer: { type: 'string', description: "The answer to record, in the owner's voice." },
      },
      required: ['questionId', 'answer'],
    },
  },
  {
    name: 'propose_decide_approval',
    description:
      'Prepare an approve/reject decision on a pending approval FOR THE OWNER TO CONFIRM. Does NOT decide anything — it surfaces a confirmation card the owner must approve. Get the approvalId from list_pending_approvals first. To decide several at once, call this once per approval.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        note: { type: 'string', description: 'Optional short note recorded with the decision.' },
      },
      required: ['approvalId', 'decision'],
    },
  },
];

export function createOpsChatToolset(auth: AuthScope): OpsChatToolset {
  const proposals: OpsChatProposal[] = [];
  const addProposal = (p: OpsChatProposal) => {
    const id = p.kind === 'answer_question' ? p.questionId : p.approvalId;
    if (!proposals.some((x) => (x.kind === 'answer_question' ? x.questionId : x.approvalId) === id)) proposals.push(p);
  };

  const runTool: ToolRunner = async ({ name, input }) => {
    switch (name) {
      case 'get_objective_criteria': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const objRef = argStr(input, 'objective');
        const ctx = ctxFor(auth, p);
        return withTenant(ctx, async (tx) => {
          const objs = await listObjectives(tx, ctx);
          if (objs.length === 0) return JSON.stringify({ workspace: p.name, note: 'This workspace has no objectives.' });
          const target = objRef
            ? objs.find((o) => o.id === objRef || o.title.toLowerCase().includes(objRef.toLowerCase()))
            : (objs.find((o) => o.status === 'active') ?? objs[0]);
          if (!target) return JSON.stringify({ workspace: p.name, note: 'No matching objective.' });
          const health = await assessWorkspaceHealth(tx, ctx);
          const blockers = health.findings
            .filter((f) => f.dimension === 'outcome' || f.dimension === 'execution')
            .map((f) => ({ title: f.title, evidence: f.evidence, recommendedAction: f.recommendedAction }));
          return JSON.stringify({
            workspace: p.name,
            objective: target.title,
            status: target.status,
            criteriaMet: target.successCriteria.filter((c) => MET.has(c.status)).length,
            criteriaTotal: target.successCriteria.length,
            criteria: target.successCriteria.map((c) => ({
              label: c.label,
              target: `${c.target} ${c.unit}`.trim(),
              metric: c.metric,
              status: c.status,
              verifiedAt: c.verifiedAt,
            })),
            blockers,
            progress: target.progress,
          });
        });
      }
      case 'list_objectives': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        return withTenant(ctx, async (tx) => {
          const objs = await listObjectives(tx, ctx);
          return JSON.stringify({
            workspace: p.name,
            objectives: objs.map((o) => ({
              id: o.id,
              title: o.title,
              status: o.status,
              criteriaMet: o.successCriteria.filter((c) => MET.has(c.status)).length,
              criteriaTotal: o.successCriteria.length,
            })),
          });
        });
      }
      case 'list_tasks': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const openOnly = argBool(input, 'open_only');
        const ctx = ctxFor(auth, p);
        return withTenant(ctx, async (tx) => {
          const rows = await listTasks(tx, ctx, 100);
          const open = new Set(['pending', 'running', 'awaiting_approval']);
          const filtered = openOnly ? rows.filter((r) => open.has(r.status)) : rows;
          return JSON.stringify({
            workspace: p.name,
            count: filtered.length,
            tasks: filtered.slice(0, 40).map((r) => ({ id: r.id, title: r.title, status: r.status })),
          });
        });
      }
      case 'get_task_detail': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const taskRef = argStr(input, 'task');
        const ctx = ctxFor(auth, p);
        return withTenant(ctx, async (tx) => {
          const tasks = await listTasks(tx, ctx, 100);
          const t = tasks.find((x) => x.id === taskRef || x.title.toLowerCase().includes(taskRef.toLowerCase()));
          if (!t) return JSON.stringify({ workspace: p.name, note: 'No matching task.' });
          const detail = await getTask(tx, ctx, t.id);
          const runs = [...(await listRuns(tx, ctx, t.id))].sort(
            (a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
          );
          const latest = runs[0];
          let failingSteps: unknown[] = [];
          if (latest && latest.status === 'failed') {
            const steps = await listRunSteps(tx, ctx, latest.id);
            failingSteps = steps
              .filter((s) => !s.succeeded)
              .map((s) => ({ step: s.stepNumber, kind: s.kind, error: s.errorMessage, verdict: s.verdict }));
          }
          return JSON.stringify({
            workspace: p.name,
            task: { title: detail.title, status: detail.status, objective: detail.objectiveTitle },
            latestRun: latest ? { status: latest.status, error: latest.errorMessage, finishedAt: latest.finishedAt } : null,
            failingSteps,
          });
        });
      }
      case 'list_open_questions': {
        const filterRef = argStr(input, 'project');
        const all = await openQuestionsForOwner(auth.userId, auth.projects, auth.orgRoles);
        const filtered = filterRef
          ? all.filter((q) => {
              const p = resolveProject(auth.projects, filterRef);
              return p ? q.projectKey === p.key : false;
            })
          : all;
        return JSON.stringify({
          count: filtered.length,
          questions: filtered.map((q) => ({
            questionId: q.questionId,
            workspace: q.workspaceName,
            askedBy: q.askedBy,
            question: q.question,
          })),
        });
      }
      case 'list_pending_approvals': {
        const filterRef = argStr(input, 'project');
        const filterProj = filterRef ? resolveProject(auth.projects, filterRef) : null;
        const all = await pendingApprovals(auth);
        const filtered = filterProj ? all.filter((a) => a.project.key === filterProj.key) : all;
        return JSON.stringify({
          count: filtered.length,
          approvals: filtered.map(({ project, row }) => ({
            approvalId: row.id,
            workspace: project.name,
            actionType: row.actionType,
            summary: row.summary,
            proposedBy: row.ownerName,
            task: row.taskTitle,
          })),
        });
      }
      case 'get_approval_detail': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const approvalId = argStr(input, 'approvalId');
        const ctx = ctxFor(auth, p);
        try {
          const d = await withTenant(ctx, (tx) => getApprovalDetail(tx, ctx, approvalId));
          return JSON.stringify({
            workspace: p.name,
            approvalId: d.id,
            actionType: d.actionType,
            summary: d.summary,
            status: d.status,
            task: d.taskTitle,
            objective: d.objectiveTitle,
            proposedBy: d.ownerName,
            hasPendingDuplicate: d.hasPendingDuplicate,
            originatingTaskCancelled: d.originatingTaskCancelled,
          });
        } catch {
          return JSON.stringify({ error: 'No such approval in that workspace.' });
        }
      }
      case 'propose_answer_question': {
        const questionId = argStr(input, 'questionId');
        const answer = argStr(input, 'answer');
        if (!questionId || !answer) return JSON.stringify({ error: 'questionId and answer are both required.' });
        if (answer.length > 8000) return JSON.stringify({ error: 'Answer is too long (max 8000 chars).' });
        const all = await openQuestionsForOwner(auth.userId, auth.projects, auth.orgRoles);
        const q: OpenOwnerQuestion | undefined = all.find((x) => x.questionId === questionId);
        if (!q) {
          return JSON.stringify({
            error: 'That question is not open, or you do not administer its workspace. Call list_open_questions for valid ids.',
          });
        }
        addProposal({
          kind: 'answer_question',
          questionId: q.questionId,
          projectKey: q.projectKey,
          workspaceName: q.workspaceName,
          question: q.question,
          answer,
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: an answer to the question in ${q.workspaceName}. Tell the owner it is ready to confirm below. Do NOT claim it is saved yet.`,
        });
      }
      case 'propose_decide_approval': {
        const approvalId = argStr(input, 'approvalId');
        const rawDecision = argStr(input, 'decision').toLowerCase();
        const note = argStr(input, 'note');
        if (!approvalId || (rawDecision !== 'approve' && rawDecision !== 'reject')) {
          return JSON.stringify({ error: "approvalId and decision ('approve' or 'reject') are required." });
        }
        const match = (await pendingApprovals(auth)).find((a) => a.row.id === approvalId);
        if (!match) {
          return JSON.stringify({
            error: 'That approval is not pending, or you do not administer its workspace. Call list_pending_approvals for valid ids.',
          });
        }
        addProposal({
          kind: 'decide_approval',
          approvalId,
          projectKey: match.project.key,
          workspaceName: match.project.name,
          summary: match.row.summary,
          decision: rawDecision === 'approve' ? 'approved' : 'rejected',
          note,
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: ${rawDecision} the approval in ${match.project.name}. Tell the owner it is ready to confirm below. Do NOT claim it is decided yet.`,
        });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  };

  return { tools: OPS_CHAT_TOOLS, runTool, getProposals: () => proposals };
}
