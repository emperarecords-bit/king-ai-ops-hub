import 'server-only';
import { type TenantContext } from '@/types/domain';
import { type ToolSpec, type ToolRunner } from '@/types/provider';
import { withTenant } from '@/db/tenant';
import { type ProjectAccessRecord } from '@/db/system';
import { listObjectives } from '@/domain/objectives/objectives';
import { assessWorkspaceHealth } from '@/domain/health/health';
import { listTasks, getTask, listRuns, listRunSteps } from '@/domain/tasks/tasks';
import { openQuestionsForOwner, type OpenOwnerQuestion } from '@/domain/questions/questions';

/**
 * Ops Chat v2 tool layer. The model may call these to fetch deeper detail on
 * demand (drill-down READS run instantly through the RLS boundary) and to
 * PROPOSE an answer to an owner-question (the propose tool NEVER writes — it
 * records a proposal the route surfaces for the owner to confirm; the write
 * happens only in the confirm endpoint, which re-validates via answerOwnerQuestion).
 *
 * Read handlers resolve a project the chat mentions (by name or key) to a
 * TenantContext and run inside withTenant, so every read is tenant-scoped.
 */

export interface OpsChatProposal {
  readonly kind: 'answer_question';
  readonly questionId: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  readonly question: string;
  readonly answer: string;
}

export interface OpsChatToolset {
  readonly tools: readonly ToolSpec[];
  readonly runTool: ToolRunner;
  /** The pending proposal recorded during this turn, if the model proposed one. */
  getProposal(): OpsChatProposal | null;
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

export const OPS_CHAT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_objective_criteria',
    description:
      "Get a workspace's objective, its success criteria (each with target and met/unmet status), and what is blocking the unmet ones. Use this when asked what an objective's criteria are, why it isn't done, or what it would take to complete it.",
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
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        open_only: { type: 'boolean' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_task_detail',
    description:
      "Get a task's detail and its latest run outcome — including the failure reason and the failing step when it failed. Use to explain why a task or run failed.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        task: { type: 'string', description: 'Task title or id.' },
      },
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
    name: 'propose_answer_question',
    description:
      'Prepare an answer to an owner-question FOR THE OWNER TO CONFIRM. This does NOT record anything itself — it surfaces a confirmation card to the owner, who must approve before it is saved. Always call list_open_questions first to get the correct questionId, and confirm the wording with the owner before proposing.',
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: 'The id of the open owner-question (from list_open_questions).' },
        answer: { type: 'string', description: "The answer to record, in the owner's voice." },
      },
      required: ['questionId', 'answer'],
    },
  },
];

export function createOpsChatToolset(auth: AuthScope): OpsChatToolset {
  let proposal: OpsChatProposal | null = null;

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
          const criteria = target.successCriteria.map((c) => ({
            label: c.label,
            target: `${c.target} ${c.unit}`.trim(),
            metric: c.metric,
            status: c.status,
            verifiedAt: c.verifiedAt,
          }));
          return JSON.stringify({
            workspace: p.name,
            objective: target.title,
            status: target.status,
            criteriaMet: target.successCriteria.filter((c) => MET.has(c.status)).length,
            criteriaTotal: target.successCriteria.length,
            criteria,
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
            latestRun: latest
              ? { status: latest.status, error: latest.errorMessage, finishedAt: latest.finishedAt }
              : null,
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
      case 'propose_answer_question': {
        const questionId = argStr(input, 'questionId');
        const answer = argStr(input, 'answer');
        if (!questionId || !answer) return JSON.stringify({ error: 'questionId and answer are both required.' });
        if (answer.length > 8000) return JSON.stringify({ error: 'Answer is too long (max 8000 chars).' });
        const all = await openQuestionsForOwner(auth.userId, auth.projects, auth.orgRoles);
        const q: OpenOwnerQuestion | undefined = all.find((x) => x.questionId === questionId);
        if (!q) {
          return JSON.stringify({
            error: 'That question is not open, or you do not administer its workspace. Call list_open_questions to get a valid id.',
          });
        }
        proposal = {
          kind: 'answer_question',
          questionId: q.questionId,
          projectKey: q.projectKey,
          workspaceName: q.workspaceName,
          question: q.question,
          answer,
        };
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: recording this answer to the question in ${q.workspaceName}. Tell the owner it is ready and ask them to confirm below. Do NOT claim it is saved yet.`,
        });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  };

  return { tools: OPS_CHAT_TOOLS, runTool, getProposal: () => proposal };
}
