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
import { listAgents } from '@/domain/agents/agents';
import { listRepoLinks } from '@/domain/github/links';
import { getGitHubClient } from '@/domain/github/client';
import {
  githubWorkspaceCapabilities,
  listWorkspaceRepos,
  listWorkspacePullRequests,
  getWorkspacePullRequest,
  getWorkspaceWorkflowRun,
  RepoNotLinkedError,
} from '@/domain/github/inspection';
import {
  createPrPayloadSchema,
  mergePrPayloadSchema,
  rerunFailedWorkflowPayloadSchema,
  findGitPrPlaceholder,
} from '@/domain/execution/git-pr-executor';
import { EXECUTOR_RISK_BY_ACTION } from '@/domain/execution/executor-policy';
import { getSupabaseClient } from '@/domain/supabase/client';
import {
  supabaseWorkspaceCapabilities,
  listWorkspaceSupabaseProjects,
  getWorkspaceSupabaseProject,
  listWorkspaceEdgeFunctions,
  listWorkspaceMigrations,
  SupabaseProjectNotLinkedError,
} from '@/domain/supabase/inspection';

/**
 * Ops Chat tool layer (v2 + v2.1). The model may call these to fetch deeper
 * detail on demand (READS run instantly through the RLS boundary) and to PROPOSE
 * an action — answering an owner-question or deciding a pending approval. Propose
 * tools NEVER write: they validate and record a proposal that the route surfaces
 * for the owner to confirm; the write happens only in the confirm endpoint, which
 * re-runs the same governed domain path (and re-validates role + tenant there).
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
    }
  | {
      readonly kind: 'dispatch_task';
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly title: string;
      readonly instructions: string;
      readonly agentId: string;
      readonly agentName: string;
    }
  | {
      readonly kind: 'rerun_task';
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly taskId: string;
      readonly taskTitle: string;
    }
  | {
      readonly kind: 'github_pr';
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly repo: string;
      readonly branch: string;
      /** The PR target, resolved for the card (the linked repo's default branch when unspecified). */
      readonly baseBranch: string;
      readonly title: string;
      readonly body: string;
      readonly riskClass: string;
      /** Carried to the confirm boundary (the proposed code); the card shows paths only, never content. */
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    }
  | {
      readonly kind: 'github_merge';
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly repo: string;
      readonly prNumber: number;
      readonly expectedHeadSha: string;
      readonly expectedBaseBranch: string;
      readonly mergeMethod: 'squash' | 'merge' | 'rebase';
      readonly riskClass: string;
    }
  | {
      readonly kind: 'github_rerun';
      readonly projectKey: string;
      readonly workspaceName: string;
      readonly repo: string;
      readonly runId: number;
      readonly expectedHeadSha: string;
      readonly expectedRunAttempt: number;
      readonly riskClass: string;
    };

function proposalKey(p: OpsChatProposal): string {
  switch (p.kind) {
    case 'answer_question':
      return `q:${p.questionId}`;
    case 'decide_approval':
      return `a:${p.approvalId}`;
    case 'rerun_task':
      return `r:${p.taskId}`;
    case 'dispatch_task':
      return `d:${p.projectKey}:${p.title.toLowerCase()}`;
    case 'github_pr':
      return `gh:${p.projectKey}:${p.repo}:${p.branch.toLowerCase()}`;
    case 'github_merge':
      return `ghm:${p.projectKey}:${p.repo}:${p.prNumber}`;
    case 'github_rerun':
      return `ghr:${p.projectKey}:${p.repo}:${p.runId}`;
  }
}

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
function argNum(input: unknown, key: string): number | null {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
function argFiles(input: unknown): Array<{ path: string; content: string }> {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>).files : undefined;
  if (!Array.isArray(v)) return [];
  const out: Array<{ path: string; content: string }> = [];
  for (const f of v) {
    if (f && typeof f === 'object') {
      const path = (f as Record<string, unknown>).path;
      const content = (f as Record<string, unknown>).content;
      if (typeof path === 'string' && typeof content === 'string') out.push({ path, content });
    }
  }
  return out;
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
  {
    name: 'list_agents',
    description: "List a workspace's AI agents (employees) — name and role — so you can pick which one should own a dispatched task.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'propose_dispatch_task',
    description:
      'Prepare to START NEW WORK in a workspace — create a task and queue an AI run FOR THE OWNER TO CONFIRM. This SPENDS money (an AI run uses tokens) and runs NOTHING until the owner confirms. Give a short title and clear instructions. Optionally name which agent owns it (use list_agents); otherwise the first available agent is used.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        title: { type: 'string', description: 'Short task title.' },
        instructions: { type: 'string', description: 'What the agent should do.' },
        agent: { type: 'string', description: 'Optional agent name to own the task.' },
      },
      required: ['project', 'title', 'instructions'],
    },
  },
  {
    name: 'propose_rerun_task',
    description:
      'Prepare to RE-RUN an existing task (e.g. retry a failed one) FOR THE OWNER TO CONFIRM. This SPENDS money and runs nothing until the owner confirms. Find the task with list_tasks or get_task_detail first.',
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
    name: 'github_capabilities',
    description:
      "Read which governed GitHub actions this workspace can do right now — whether GitHub is configured, the git_pr executor is registered and enabled, which repositories are linked, and whether a pull-request can be proposed. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'list_github_repos',
    description: "List the GitHub repositories linked to a workspace, with each repo's default branch. Read-only.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'list_pull_requests',
    description:
      "List pull requests on a linked repository (default: open). Returns number, title, state, head/base branch, head SHA, and URL. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: "Default 'open'." },
      },
      required: ['project', 'repo'],
    },
  },
  {
    name: 'get_pull_request',
    description:
      'Get one pull request on a linked repository plus its rolled-up CI/check state (success/failure/pending). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['project', 'repo', 'number'],
    },
  },
  {
    name: 'propose_github_pr',
    description:
      'Prepare an EXACT GitHub pull request (new branch + commit + PR on a linked repo) FOR THE OWNER TO CONFIRM. Does NOT create anything — it surfaces a confirmation card. The branch is a NEW work branch (never the default branch); each file must carry its COMPLETE intended content (never a placeholder or summary). On confirm it runs through the governed git_pr executor.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        branch: { type: 'string', description: 'The NEW work branch the changes land on (never a default branch).' },
        base_branch: { type: 'string', description: "PR target; defaults to the repo's default branch." },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body (optional).' },
        files: {
          type: 'array',
          description: 'Files to create/replace; each with its complete intended content.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['project', 'repo', 'branch', 'title', 'files'],
    },
  },
  {
    name: 'get_workflow_run',
    description:
      'Get one GitHub Actions workflow run on a linked repository — its head SHA, run attempt, status (queued/in_progress/completed), and conclusion (success/failure/…). Read-only. Use this before proposing a rerun to read the exact run id, attempt, head SHA, and confirm it is completed+failed.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        run_id: { type: 'number', description: 'The workflow run id.' },
      },
      required: ['project', 'repo', 'run_id'],
    },
  },
  {
    name: 'propose_github_merge',
    description:
      'Prepare to MERGE an existing pull request on a linked repo FOR THE OWNER TO CONFIRM. Does NOT merge anything — it surfaces a confirmation card. Read the PR first with get_pull_request to get the exact head SHA and base branch. On confirm, the governed executor refuses a draft, a closed/already-merged PR, a moved head (stale SHA), a mismatched base, or non-green CI, then squash-merges (default) and verifies. Provide the exact PR number, expected head SHA, and expected base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        pr_number: { type: 'number', description: 'The pull request number to merge.' },
        expected_head_sha: { type: 'string', description: 'The PR head SHA you reviewed; a moved head is refused.' },
        expected_base_branch: { type: 'string', description: 'The branch the PR must be merging into.' },
        merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: "Default 'squash'." },
      },
      required: ['project', 'repo', 'pr_number', 'expected_head_sha', 'expected_base_branch'],
    },
  },
  {
    name: 'propose_github_rerun',
    description:
      'Prepare to RE-RUN THE FAILED JOBS of a completed, failed GitHub Actions workflow run on a linked repo FOR THE OWNER TO CONFIRM. Does NOT rerun anything — it surfaces a confirmation card. Read the run first with get_workflow_run. On confirm, the governed executor refuses a run that is not completed+failed, or whose head SHA / attempt do not match, then uses the rerun-failed-jobs endpoint (never workflow_dispatch). Provide the exact run id, expected head SHA, and expected run attempt.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        repo: { type: 'string', description: 'Canonical owner/repo; must be linked to this workspace.' },
        run_id: { type: 'number', description: 'The workflow run id to re-run failed jobs for.' },
        expected_head_sha: { type: 'string', description: 'The run head SHA you inspected; a mismatch is refused.' },
        expected_run_attempt: { type: 'number', description: 'The run attempt number you inspected; a stale attempt is refused.' },
      },
      required: ['project', 'repo', 'run_id', 'expected_head_sha', 'expected_run_attempt'],
    },
  },
  {
    name: 'supabase_capabilities',
    description:
      'Read which governed Supabase inspection this workspace can do right now — whether the Supabase Management connection is configured, which Supabase projects are linked, and whether inspection is available. Read-only. (Phase 2C is read-only: no deploy/SQL/migration actions exist yet.)',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'list_supabase_projects',
    description: 'List the Supabase projects linked to a workspace (their refs + labels). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Workspace name or key.' } },
      required: ['project'],
    },
  },
  {
    name: 'inspect_supabase_project',
    description:
      'Read one linked Supabase project’s state: name, region, status, and database version. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        project_ref: { type: 'string', description: 'The Supabase project ref; must be linked to this workspace.' },
      },
      required: ['project', 'project_ref'],
    },
  },
  {
    name: 'inspect_edge_functions',
    description:
      'List a linked Supabase project’s edge functions with each function’s slug, status, version, and verify_jwt. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        project_ref: { type: 'string', description: 'The Supabase project ref; must be linked to this workspace.' },
      },
      required: ['project', 'project_ref'],
    },
  },
  {
    name: 'inspect_migrations',
    description: 'List a linked Supabase project’s applied database migrations (version + name). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Workspace name or key.' },
        project_ref: { type: 'string', description: 'The Supabase project ref; must be linked to this workspace.' },
      },
      required: ['project', 'project_ref'],
    },
  },
];

export function createOpsChatToolset(auth: AuthScope): OpsChatToolset {
  const proposals: OpsChatProposal[] = [];
  const addProposal = (p: OpsChatProposal) => {
    const k = proposalKey(p);
    if (!proposals.some((x) => proposalKey(x) === k)) proposals.push(p);
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
      case 'list_agents': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        return withTenant(ctx, async (tx) => {
          const ags = await listAgents(tx, ctx);
          return JSON.stringify({
            workspace: p.name,
            agents: ags.filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, role: a.role })),
          });
        });
      }
      case 'propose_dispatch_task': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        if (p.projectRole !== 'admin') {
          return JSON.stringify({ error: 'You must be an admin of that workspace to dispatch work.' });
        }
        const title = argStr(input, 'title');
        const instructions = argStr(input, 'instructions');
        if (!title || !instructions) return JSON.stringify({ error: 'title and instructions are required.' });
        if (instructions.length > 32_000) return JSON.stringify({ error: 'Instructions too long (max 32000 chars).' });
        const agentRef = argStr(input, 'agent');
        const ctx = ctxFor(auth, p);
        const agent = await withTenant(ctx, async (tx) => {
          const ags = (await listAgents(tx, ctx)).filter((a) => a.enabled);
          if (agentRef) return ags.find((a) => a.id === agentRef || a.name.toLowerCase().includes(agentRef.toLowerCase())) ?? null;
          return ags[0] ?? null;
        });
        if (!agent) return JSON.stringify({ error: 'No available agent to own the task in that workspace — call list_agents.' });
        addProposal({
          kind: 'dispatch_task',
          projectKey: p.key,
          workspaceName: p.name,
          title,
          instructions,
          agentId: agent.id,
          agentName: agent.name,
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: a new task "${title}" in ${p.name}, run by ${agent.name}. This will START an AI run (uses tokens) only after the owner confirms. Do NOT claim it is running yet.`,
        });
      }
      case 'propose_rerun_task': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        if (p.projectRole !== 'admin') {
          return JSON.stringify({ error: 'You must be an admin of that workspace to re-run work.' });
        }
        const taskRef = argStr(input, 'task');
        if (!taskRef) return JSON.stringify({ error: 'task is required.' });
        const ctx = ctxFor(auth, p);
        const t = await withTenant(ctx, async (tx) => {
          const rows = await listTasks(tx, ctx, 100);
          return rows.find((x) => x.id === taskRef || x.title.toLowerCase().includes(taskRef.toLowerCase())) ?? null;
        });
        if (!t) return JSON.stringify({ error: 'No matching task — call list_tasks.' });
        addProposal({ kind: 'rerun_task', projectKey: p.key, workspaceName: p.name, taskId: t.id, taskTitle: t.title });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: re-run "${t.title}" in ${p.name}. This will START an AI run (uses tokens) only after the owner confirms. Do NOT claim it is running yet.`,
        });
      }
      case 'github_capabilities': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        const caps = await withTenant(ctx, (tx) => githubWorkspaceCapabilities(tx, ctx));
        return JSON.stringify({ workspace: p.name, ...caps });
      }
      case 'list_github_repos': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        const repos = await withTenant(ctx, (tx) => listWorkspaceRepos(tx, ctx));
        return JSON.stringify({ workspace: p.name, repos });
      }
      case 'list_pull_requests': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const repo = argStr(input, 'repo');
        const stateArg = argStr(input, 'state');
        const state = stateArg === 'closed' || stateArg === 'all' ? stateArg : 'open';
        const ctx = ctxFor(auth, p);
        try {
          const prs = await withTenant(ctx, (tx) => listWorkspacePullRequests(tx, ctx, getGitHubClient(), repo, { state }));
          return JSON.stringify({ workspace: p.name, repo, state, count: prs.length, pullRequests: prs });
        } catch (err) {
          if (err instanceof RepoNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read pull requests from GitHub.' });
        }
      }
      case 'get_pull_request': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const repo = argStr(input, 'repo');
        const number = argNum(input, 'number');
        if (number === null) return JSON.stringify({ error: 'A pull request number is required.' });
        const ctx = ctxFor(auth, p);
        try {
          const { pr, checks } = await withTenant(ctx, (tx) => getWorkspacePullRequest(tx, ctx, getGitHubClient(), repo, number));
          return JSON.stringify({ workspace: p.name, repo, pullRequest: pr, ci: { state: checks.state, checks: checks.checks } });
        } catch (err) {
          if (err instanceof RepoNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read that pull request from GitHub.' });
        }
      }
      case 'propose_github_pr': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        if (p.projectRole !== 'admin') {
          return JSON.stringify({ error: 'You must be an admin of that workspace to propose a GitHub action.' });
        }
        const repo = argStr(input, 'repo');
        const branch = argStr(input, 'branch');
        const baseBranchArg = argStr(input, 'base_branch');
        const title = argStr(input, 'title');
        const body = argStr(input, 'body');
        const files = argFiles(input);
        const ctx = ctxFor(auth, p);
        // The repo must be linked (and we read its default branch for the card's PR target).
        const link = await withTenant(ctx, (tx) => listRepoLinks(tx, ctx)).then((ls) => ls.find((l) => l.repoFullName === repo) ?? null);
        if (!link) return JSON.stringify({ error: `Repository "${repo}" is not linked to this workspace. Use list_github_repos.` });
        // Validate into the exact executable payload — bad shapes are refusals, not best-effort repairs.
        const parsed = createPrPayloadSchema.safeParse({ operation: 'create_pr', repo, branch, title, body, ...(baseBranchArg ? { baseBranch: baseBranchArg } : {}), files });
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return JSON.stringify({ error: `That pull request is not valid: ${issues}` });
        }
        for (const f of parsed.data.files) {
          const marker = findGitPrPlaceholder(f.content);
          if (marker) return JSON.stringify({ error: `File "${f.path}" contains placeholder text ("${marker}") instead of real content.` });
        }
        const baseBranch = parsed.data.baseBranch ?? link.defaultBranch;
        if (branch === link.defaultBranch || branch === 'main' || branch === 'master') {
          return JSON.stringify({ error: `"${branch}" is a default/protected branch — propose a NEW work branch; the PR targets "${baseBranch}".` });
        }
        addProposal({
          kind: 'github_pr',
          projectKey: p.key,
          workspaceName: p.name,
          repo: parsed.data.repo,
          branch: parsed.data.branch,
          baseBranch,
          title: parsed.data.title,
          body: parsed.data.body,
          riskClass: EXECUTOR_RISK_BY_ACTION.git_pr,
          files: parsed.data.files.map((f) => ({ path: f.path, content: f.content })),
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: a pull request in ${parsed.data.repo} from ${parsed.data.branch} into ${baseBranch}. Tell the owner it is ready to confirm below. Do NOT claim it is created yet.`,
        });
      }
      case 'get_workflow_run': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const repo = argStr(input, 'repo');
        const runId = argNum(input, 'run_id');
        if (runId === null) return JSON.stringify({ error: 'A workflow run id is required.' });
        const ctx = ctxFor(auth, p);
        try {
          const run = await withTenant(ctx, (tx) => getWorkspaceWorkflowRun(tx, ctx, getGitHubClient(), repo, runId));
          return JSON.stringify({ workspace: p.name, repo, workflowRun: run });
        } catch (err) {
          if (err instanceof RepoNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read that workflow run from GitHub.' });
        }
      }
      case 'propose_github_merge': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        if (p.projectRole !== 'admin') {
          return JSON.stringify({ error: 'You must be an admin of that workspace to propose a GitHub action.' });
        }
        const repo = argStr(input, 'repo');
        const prNumber = argNum(input, 'pr_number');
        const expectedHeadSha = argStr(input, 'expected_head_sha');
        const expectedBaseBranch = argStr(input, 'expected_base_branch');
        const mergeMethodArg = argStr(input, 'merge_method');
        if (prNumber === null) return JSON.stringify({ error: 'A pull request number is required.' });
        const ctx = ctxFor(auth, p);
        const link = await withTenant(ctx, (tx) => listRepoLinks(tx, ctx)).then((ls) => ls.find((l) => l.repoFullName === repo) ?? null);
        if (!link) return JSON.stringify({ error: `Repository "${repo}" is not linked to this workspace. Use list_github_repos.` });
        const parsed = mergePrPayloadSchema.safeParse({
          operation: 'merge_pr',
          repo,
          prNumber,
          expectedHeadSha,
          expectedBaseBranch,
          ...(mergeMethodArg ? { mergeMethod: mergeMethodArg } : {}),
        });
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return JSON.stringify({ error: `That merge is not valid: ${issues}` });
        }
        addProposal({
          kind: 'github_merge',
          projectKey: p.key,
          workspaceName: p.name,
          repo: parsed.data.repo,
          prNumber: parsed.data.prNumber,
          expectedHeadSha: parsed.data.expectedHeadSha,
          expectedBaseBranch: parsed.data.expectedBaseBranch,
          mergeMethod: parsed.data.mergeMethod,
          riskClass: EXECUTOR_RISK_BY_ACTION.git_pr,
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: merge PR #${parsed.data.prNumber} in ${parsed.data.repo} into ${parsed.data.expectedBaseBranch}. Tell the owner it is ready to confirm below. Do NOT claim it is merged yet.`,
        });
      }
      case 'propose_github_rerun': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        if (p.projectRole !== 'admin') {
          return JSON.stringify({ error: 'You must be an admin of that workspace to propose a GitHub action.' });
        }
        const repo = argStr(input, 'repo');
        const runId = argNum(input, 'run_id');
        const expectedHeadSha = argStr(input, 'expected_head_sha');
        const expectedRunAttempt = argNum(input, 'expected_run_attempt');
        if (runId === null) return JSON.stringify({ error: 'A workflow run id is required.' });
        if (expectedRunAttempt === null) return JSON.stringify({ error: 'An expected run attempt is required.' });
        const ctx = ctxFor(auth, p);
        const link = await withTenant(ctx, (tx) => listRepoLinks(tx, ctx)).then((ls) => ls.find((l) => l.repoFullName === repo) ?? null);
        if (!link) return JSON.stringify({ error: `Repository "${repo}" is not linked to this workspace. Use list_github_repos.` });
        const parsed = rerunFailedWorkflowPayloadSchema.safeParse({
          operation: 'rerun_failed_workflow',
          repo,
          runId,
          expectedHeadSha,
          expectedRunAttempt,
        });
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          return JSON.stringify({ error: `That rerun is not valid: ${issues}` });
        }
        addProposal({
          kind: 'github_rerun',
          projectKey: p.key,
          workspaceName: p.name,
          repo: parsed.data.repo,
          runId: parsed.data.runId,
          expectedHeadSha: parsed.data.expectedHeadSha,
          expectedRunAttempt: parsed.data.expectedRunAttempt,
          riskClass: EXECUTOR_RISK_BY_ACTION.git_pr,
        });
        return JSON.stringify({
          prepared: true,
          note: `Prepared for the owner to confirm: re-run the failed jobs of run ${parsed.data.runId} in ${parsed.data.repo}. Tell the owner it is ready to confirm below. Do NOT claim it is rerun yet.`,
        });
      }
      case 'supabase_capabilities': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        const caps = await withTenant(ctx, (tx) => supabaseWorkspaceCapabilities(tx, ctx));
        return JSON.stringify({ workspace: p.name, ...caps });
      }
      case 'list_supabase_projects': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ctx = ctxFor(auth, p);
        const projects = await withTenant(ctx, (tx) => listWorkspaceSupabaseProjects(tx, ctx));
        return JSON.stringify({ workspace: p.name, projects });
      }
      case 'inspect_supabase_project': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ref = argStr(input, 'project_ref');
        const ctx = ctxFor(auth, p);
        try {
          const info = await withTenant(ctx, (tx) => getWorkspaceSupabaseProject(tx, ctx, getSupabaseClient(), ref));
          return JSON.stringify({ workspace: p.name, project: info });
        } catch (err) {
          if (err instanceof SupabaseProjectNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read that Supabase project.' });
        }
      }
      case 'inspect_edge_functions': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ref = argStr(input, 'project_ref');
        const ctx = ctxFor(auth, p);
        try {
          const functions = await withTenant(ctx, (tx) => listWorkspaceEdgeFunctions(tx, ctx, getSupabaseClient(), ref));
          return JSON.stringify({ workspace: p.name, projectRef: ref, count: functions.length, edgeFunctions: functions });
        } catch (err) {
          if (err instanceof SupabaseProjectNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read edge functions from Supabase.' });
        }
      }
      case 'inspect_migrations': {
        const p = resolveProject(auth.projects, argStr(input, 'project'));
        if (!p) return JSON.stringify({ error: 'No workspace matched that name/key.' });
        const ref = argStr(input, 'project_ref');
        const ctx = ctxFor(auth, p);
        try {
          const migrations = await withTenant(ctx, (tx) => listWorkspaceMigrations(tx, ctx, getSupabaseClient(), ref));
          return JSON.stringify({ workspace: p.name, projectRef: ref, count: migrations.length, migrations });
        } catch (err) {
          if (err instanceof SupabaseProjectNotLinkedError) return JSON.stringify({ error: err.message });
          return JSON.stringify({ error: 'Could not read migrations from Supabase.' });
        }
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  };

  return { tools: OPS_CHAT_TOOLS, runTool, getProposals: () => proposals };
}
