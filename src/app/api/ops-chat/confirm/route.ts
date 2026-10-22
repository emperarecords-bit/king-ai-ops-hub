import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { writeAudit } from '@/domain/audit/audit';
import { requireTenant, requireUser } from '@/domain/auth/guard';
import { withTenant, withUser } from '@/db/tenant';
import { getDb } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { answerOwnerQuestion } from '@/domain/questions/questions';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible } from '@/domain/execution/execute-on-approval';
import { createTask } from '@/domain/tasks/tasks';
import { enqueueRun, requestRerun, RerunRefusedError } from '@/domain/jobs/jobs';
import { listAgents } from '@/domain/agents/agents';
import { assertUpdateCardCurrent } from '@/domain/opschat/update-card';
import {
  executeGitHubPrFromOpsChat,
  executeGitHubMergeFromOpsChat,
  executeGitHubRerunFromOpsChat,
  executeGitHubRevertFromOpsChat,
} from '@/domain/opschat/github-action';
import { executeSupabaseDeployFromOpsChat } from '@/domain/opschat/supabase-action';
import { executeVercelMutationFromOpsChat, type OpsChatVercelMutationInput } from '@/domain/opschat/vercel-action';
import { executeAccurateBidsFromOpsChat } from '@/domain/opschat/accuratebids-action';
import { loadProposal, transitionProposal } from '@/domain/opschat/conversations';

/**
 * POST — act on a persisted Ops Chat proposal. The ONLY place Ops Chat writes.
 *
 * PROPOSAL-ID AUTHORITATIVE: the client sends ONLY `{ proposalId, intent }`. The server
 * loads the owner's persisted, IMMUTABLE proposal row and uses THAT as the authoritative
 * payload — the browser is out of the trust boundary entirely. A stored payload cannot be
 * tampered with (column-grant immutability, see rls.sql), and a stale client cannot forge
 * a different action.
 *
 * Ordering (deliberate):
 *   1. authenticate the user; load the immutable proposal (user-scoped).
 *   2. `cancel` → CAS pending→cancelled only; never acquires `confirming`, never executes.
 *   3. `confirm` → PRECHECK first (reconstruct + validate the action from the stored payload,
 *      then tenant/current-access + admin), so a membership failure never strands a card in
 *      `confirming`. THEN CAS pending→confirming immediately before execution — two tabs can
 *      both pass the precheck, but only one acquires `confirming`; the other gets 409.
 *   4. execute the governed action with the SERVER-stored fields.
 *   5. success → CAS confirming→done (storing the executed result). An authz / live-state
 *      "no longer valid" failure → confirming→stale (a new proposal is required). An
 *      execution / provider failure → confirming→error.
 *
 * The governed executors (github/supabase/vercel) still re-verify admin, payload integrity,
 * executor enablement, a fresh payload-bound confirmation, and idempotency before any write.
 *
 * SPEND: answer_question / decide_approval do not themselves call a model. dispatch_task /
 * rerun_task ENQUEUE a run whose budget/authorization is governed on the execution path. A
 * bounded per-user anti-abuse rate limit guards this endpoint.
 */

const Input = z.object({
  proposalId: z.string().uuid(),
  intent: z.enum(['confirm', 'cancel']),
});

/** The validated, server-reconstructed action body — same per-kind fields the proposal was
 *  created with, keyed by the confirm `action` (derived from the stored proposal `kind`). */
const ActionBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer_question'),
    projectKey: z.string().min(1),
    questionId: z.string().uuid(),
    answer: z.string().trim().min(1).max(8000),
  }),
  z.object({
    action: z.literal('decide_approval'),
    projectKey: z.string().min(1),
    approvalId: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal('dispatch_task'),
    projectKey: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(32_000),
    agentId: z.string().uuid(),
    /** Absent on cards stored before reviewer assignment existed → no reviewer (unchanged behavior). */
    reviewerAgentId: z.string().uuid().nullish(),
    /** P5c-2: an "update this job" card's frozen basis — re-checked for freshness at confirm. */
    updateOf: z
      .object({
        taskId: z.string().uuid(),
        taskTitle: z.string(),
        runId: z.string().uuid(),
        decisions: z.number().int().nonnegative(),
        decisionIds: z.array(z.string().uuid()).max(500).optional(),
      })
      .nullish(),
  }),
  z.object({
    action: z.literal('rerun_task'),
    projectKey: z.string().min(1),
    taskId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('execute_github_pr'),
    projectKey: z.string().min(1),
    repo: z.string().trim().min(1).max(200),
    branch: z.string().trim().min(1).max(200),
    baseBranch: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(300),
    body: z.string().max(20_000).optional(),
    files: z
      .array(z.object({ path: z.string().min(1).max(500), content: z.string().max(100_000) }).strict())
      .min(1)
      .max(20),
  }),
  z.object({
    action: z.literal('execute_github_merge'),
    projectKey: z.string().min(1),
    repo: z.string().trim().min(1).max(200),
    prNumber: z.number().int().positive(),
    expectedHeadSha: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/),
    expectedBaseBranch: z.string().trim().min(1).max(200),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).optional(),
  }),
  z.object({
    action: z.literal('execute_github_rerun'),
    projectKey: z.string().min(1),
    repo: z.string().trim().min(1).max(200),
    runId: z.number().int().positive(),
    expectedHeadSha: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/),
    expectedRunAttempt: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('execute_github_revert'),
    projectKey: z.string().min(1),
    repo: z.string().trim().min(1).max(200),
    targetSha: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/),
    expectedBaseBranch: z.string().trim().min(1).max(200),
    expectedBaseHeadSha: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/),
    revertBranch: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal('execute_supabase_deploy'),
    projectKey: z.string().min(1),
    projectRef: z.string().trim().regex(/^[a-z0-9]{16,40}$/),
    functionSlug: z.string().trim().min(1).max(60),
    sourceRepo: z.string().trim().min(1).max(200),
    sourceSha: z.string().trim().regex(/^[0-9a-f]{40}$/),
    sourcePath: z.string().trim().min(1).max(300),
    entrypointPath: z.string().trim().min(1).max(200).optional(),
    importMapPath: z.string().trim().min(1).max(200).optional(),
    verifyJwt: z.boolean(),
  }),
  z.object({
    action: z.literal('execute_vercel_mutation'),
    projectKey: z.string().min(1),
    operation: z.enum(['redeploy', 'promote', 'rollback']),
    vercelProjectId: z.string().trim().regex(/^prj_[A-Za-z0-9]{8,64}$/),
    sourceDeploymentId: z.string().trim().regex(/^dpl_[A-Za-z0-9]{8,64}$/).optional(),
    expectedSourceSha: z.string().trim().regex(/^[0-9a-f]{7,40}$/).optional(),
    targetDeploymentId: z.string().trim().regex(/^dpl_[A-Za-z0-9]{8,64}$/).optional(),
    expectedTargetSha: z.string().trim().regex(/^[0-9a-f]{7,40}$/).optional(),
    expectedCurrentProductionDeploymentId: z.string().trim().regex(/^dpl_[A-Za-z0-9]{8,64}$/).optional(),
    description: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('execute_accuratebids'),
    // The stored proposal kind — must match the payload's own kind (checked in runAction).
    kind: z.enum(['accuratebids_quote', 'accuratebids_invoice', 'accuratebids_send']),
    projectKey: z.string().min(1),
    // The exact executor payload the owner saw; re-validated per kind by the bridge.
    payload: z.record(z.string(), z.unknown()),
  }),
]);

/** The stored proposal `kind` → the confirm `action`. */
const KIND_TO_ACTION: Record<string, z.infer<typeof ActionBody>['action']> = {
  answer_question: 'answer_question',
  decide_approval: 'decide_approval',
  dispatch_task: 'dispatch_task',
  rerun_task: 'rerun_task',
  github_pr: 'execute_github_pr',
  github_merge: 'execute_github_merge',
  github_rerun: 'execute_github_rerun',
  github_revert: 'execute_github_revert',
  supabase_deploy: 'execute_supabase_deploy',
  vercel_mutation: 'execute_vercel_mutation',
  accuratebids_quote: 'execute_accuratebids',
  accuratebids_invoice: 'execute_accuratebids',
  accuratebids_send: 'execute_accuratebids',
};

function statusFor(err: unknown): number {
  if (err instanceof AppError && err.code === 'forbidden') return 403;
  if (err instanceof AppError && (err.code === 'not_found' || err.code === 'conflict')) return 409;
  return 400;
}

/** A failure that means the proposal is no longer VALID (authorization lost, or the target
 *  moved / was already acted on) → the card becomes `stale` and a new proposal is required.
 *  Everything else is an execution/provider `error`. */
function isStaleFailure(err: unknown): boolean {
  return err instanceof AppError && (err.code === 'forbidden' || err.code === 'not_found' || err.code === 'conflict');
}

function requireAdmin(projectRole: string): void {
  if (projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only workspace admins can perform this action.');
  }
}

/** Run the governed action with server-stored fields. Returns the `executed` result (or null
 *  for actions that produce none). Throws on failure — the caller maps that to stale/error. */
/**
 * P4 — structured proposal lifecycle audit: ops_chat.proposal.{confirmed,cancelled,stale,error} with every id the
 * outcome knows (conversation, message, task, job, approval). Best-effort: the card's state is already recorded,
 * so a failed audit is logged, never surfaced as a failed action.
 */
async function auditProposalLifecycle(
  ctx: TenantContext,
  stored: { id: string; conversationId: string; messageId: string; kind: string; proposal: unknown },
  state: 'confirmed' | 'cancelled' | 'stale' | 'error',
  executed: unknown,
  error?: string,
): Promise<void> {
  const p = (stored.proposal ?? {}) as Record<string, unknown>;
  const r = executed && typeof executed === 'object' ? (executed as Record<string, unknown>) : {};
  const id = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const detail: Record<string, unknown> = {
    proposalId: stored.id,
    conversationId: stored.conversationId,
    messageId: stored.messageId,
    kind: stored.kind,
    taskId: id(r.taskId) ?? id(p.taskId),
    jobId: id(r.jobId),
    approvalId: id(p.approvalId) ?? id(r.approvalId),
    outcome: id(r.outcome),
    ...(error ? { error: error.slice(0, 300) } : {}),
  };
  for (const k of Object.keys(detail)) if (detail[k] === null) delete detail[k];
  try {
    await withTenant(ctx, (tx) =>
      writeAudit(tx, ctx, { action: `ops_chat.proposal.${state}`, entityType: 'ops_chat_proposal', entityId: stored.id, detail }),
    );
  } catch (err) {
    log.warn('ops-chat proposal lifecycle audit failed', { errorClass: err instanceof Error ? err.name : 'unknown', state });
  }
}

async function runAction(body: z.infer<typeof ActionBody>, ctx: TenantContext, proposalId: string): Promise<unknown> {
  switch (body.action) {
    case 'answer_question': {
      await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, body.questionId, body.answer));
      return null;
    }
    case 'decide_approval': {
      await withTenant(ctx, (tx) => decideApproval(tx, ctx, body.approvalId, body.decision, body.note));
      let executed: { outcome: string | null; message: string | null } | null = null;
      if (body.decision === 'approved') {
        try {
          const outcome = await executeApprovedIfEligible(ctx, body.approvalId);
          executed = { outcome: outcome.outcome, message: outcome.message };
        } catch (err) {
          // The decision itself IS recorded; only the downstream execution failed. The
          // proposal (recording the decision) still succeeds — we surface the failed
          // execution in the result rather than failing the whole confirm.
          log.error('ops-chat executeApprovedIfEligible failed', { err, approvalId: body.approvalId });
          executed = { outcome: 'failed', message: 'Execution failed; the approval itself is recorded.' };
        }
      }
      return executed;
    }
    case 'dispatch_task': {
      // Agent truth: the card's agent (and reviewer) must still be exactly what runs. If routing changed since
      // the card was shown (agent disabled / removed / no longer primary), refuse — the owner gets a new card
      // naming the new agent rather than a run by someone they were not told about. Nothing is started.
      const ags = await withTenant(ctx, (tx) => listAgents(tx, ctx));
      const agent = ags.find((a) => a.id === body.agentId && a.enabled && a.role === 'primary');
      if (!agent) {
        throw new AppError('conflict', 'The agent on this card is no longer available — ask Ops Chat for a new card. Nothing was started.');
      }
      const reviewer = body.reviewerAgentId ? ags.find((a) => a.id === body.reviewerAgentId && a.enabled && a.role === 'reviewer') : null;
      if (body.reviewerAgentId && !reviewer) {
        throw new AppError('conflict', 'The reviewer on this card is no longer available — ask Ops Chat for a new card. Nothing was started.');
      }
      const created = await withTenant(ctx, async (tx) => {
        // P5c-2: an update card is only started if the job is still exactly as the card froze it (same run, same
        // decisions, not already updated) — checked in THIS transaction, serialized per original task. Otherwise the
        // card goes stale with a plain reason and nothing is created.
        if (body.updateOf) await assertUpdateCardCurrent(tx, ctx, body.updateOf);
        const id = await createTask(tx, ctx, {
          title: body.title,
          input: body.instructions,
          providerSelection: agent.provider,
          // Review policy: with a reviewer on the card the run is reviewed; without one the card already told
          // the owner the result is an UNREVIEWED DRAFT (the run records review_outcome=required_unmet).
          reviewEnabled: Boolean(reviewer),
          modelTier: 'standard',
          flagshipCategory: null,
          objectiveId: null,
          scheduleId: null,
          primaryAgentId: agent.id,
          reviewerAgentId: reviewer?.id ?? null,
          // P4: this card CREATED the task (set once; a later re-run never overwrites it).
          opsChatProposalId: proposalId,
        });
        // …and queued its first attempt, so the first run is traceable to this card too.
        const enq = await enqueueRun(tx, ctx, id, 'interactive', { opsChatProposalId: proposalId });
        return { id, jobId: enq.jobId };
      });
      return { taskId: created.id, jobId: created.jobId, agentName: agent.name, reviewerName: reviewer?.name ?? null };
    }
    case 'rerun_task': {
      // A re-run is a real NEW attempt or an explicit refusal — never a job drained with no run while the card
      // says "re-run queued" (server-cooling evidence, 2026-10-19 17:19). See requestRerun.
      let r: Awaited<ReturnType<typeof requestRerun>>;
      try {
        // P4: this re-run card is linked on the NEW job (and the run it creates) — not on the task.
        r = await withTenant(ctx, (tx) => requestRerun(tx, ctx, body.taskId, { opsChatProposalId: proposalId }));
      } catch (err) {
        if (err instanceof RerunRefusedError) {
          throw new AppError(err.reason === 'not_found' ? 'not_found' : 'conflict', err.message);
        }
        throw err;
      }
      return r.status === 'started'
        ? {
            outcome: 'started',
            message: `Re-run started as a new attempt${r.previousStatus === 'completed' || r.previousStatus === 'failed' ? ` (the previous ${r.previousStatus} run and its result are kept)` : ''}.`,
            taskId: r.taskId,
            jobId: r.jobId,
            previousRunId: r.previousRunId,
          }
        : {
            outcome: 'already_queued',
            message: 'Already queued or running — nothing new was queued.',
            taskId: r.taskId,
            jobId: r.jobId,
          };
    }
    case 'execute_github_pr':
      return executeGitHubPrFromOpsChat(ctx, {
        repo: body.repo,
        branch: body.branch,
        baseBranch: body.baseBranch,
        title: body.title,
        body: body.body ?? '',
        files: body.files,
      });
    case 'execute_github_merge':
      return executeGitHubMergeFromOpsChat(ctx, {
        repo: body.repo,
        prNumber: body.prNumber,
        expectedHeadSha: body.expectedHeadSha,
        expectedBaseBranch: body.expectedBaseBranch,
        mergeMethod: body.mergeMethod,
      });
    case 'execute_github_rerun':
      return executeGitHubRerunFromOpsChat(ctx, {
        repo: body.repo,
        runId: body.runId,
        expectedHeadSha: body.expectedHeadSha,
        expectedRunAttempt: body.expectedRunAttempt,
      });
    case 'execute_github_revert':
      return executeGitHubRevertFromOpsChat(ctx, {
        repo: body.repo,
        targetSha: body.targetSha,
        expectedBaseBranch: body.expectedBaseBranch,
        expectedBaseHeadSha: body.expectedBaseHeadSha,
        revertBranch: body.revertBranch,
      });
    case 'execute_supabase_deploy':
      return executeSupabaseDeployFromOpsChat(ctx, {
        projectRef: body.projectRef,
        functionSlug: body.functionSlug,
        sourceRepo: body.sourceRepo,
        sourceSha: body.sourceSha,
        sourcePath: body.sourcePath,
        entrypointPath: body.entrypointPath,
        importMapPath: body.importMapPath,
        verifyJwt: body.verifyJwt,
      });
    case 'execute_vercel_mutation': {
      let input: OpsChatVercelMutationInput;
      if (body.operation === 'redeploy') {
        if (!body.sourceDeploymentId || !body.expectedSourceSha) throw new AppError('validation', 'redeploy requires sourceDeploymentId + expectedSourceSha.');
        input = { operation: 'redeploy', vercelProjectId: body.vercelProjectId, sourceDeploymentId: body.sourceDeploymentId, expectedSourceSha: body.expectedSourceSha };
      } else {
        if (!body.targetDeploymentId || !body.expectedTargetSha || !body.expectedCurrentProductionDeploymentId) {
          throw new AppError('validation', `${body.operation} requires targetDeploymentId + expectedTargetSha + expectedCurrentProductionDeploymentId.`);
        }
        input = {
          operation: body.operation,
          vercelProjectId: body.vercelProjectId,
          targetDeploymentId: body.targetDeploymentId,
          expectedTargetSha: body.expectedTargetSha,
          expectedCurrentProductionDeploymentId: body.expectedCurrentProductionDeploymentId,
          ...(body.description ? { description: body.description } : {}),
        };
      }
      return executeVercelMutationFromOpsChat(ctx, input);
    }
    case 'execute_accuratebids': {
      if (body.payload.kind !== body.kind) throw new AppError('validation', 'The AccurateBids card does not match its payload.');
      return executeAccurateBidsFromOpsChat(ctx, body.projectKey, body.payload);
    }
  }
}

export async function POST(req: Request): Promise<Response> {
  let input: z.infer<typeof Input>;
  try {
    input = Input.parse(await req.json());
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // 1. Authenticate (the proposal is user-private) and load the immutable proposal.
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 401 });
  }
  const stored = await withUser({ userId: user.id }, (tx) => loadProposal(tx, user.id, input.proposalId));
  if (!stored) return Response.json({ error: 'That proposal was not found.' }, { status: 404 });

  // 2. CANCEL — CAS pending→cancelled only; never executes, never acquires `confirming`.
  if (input.intent === 'cancel') {
    const cancelled = await withUser({ userId: user.id }, (tx) =>
      transitionProposal(tx, user.id, { proposalId: input.proposalId, from: 'pending', to: 'cancelled' }),
    );
    if (!cancelled) return Response.json({ error: 'This proposal is no longer pending.', state: stored.state }, { status: 409 });
    // The cancel path has no tenant context yet: resolve the card's own workspace for the audit (best-effort).
    const cancelCtx = await requireTenant(String((stored.proposal as Record<string, unknown>).projectKey ?? '')).catch(() => null);
    if (cancelCtx) await auditProposalLifecycle(cancelCtx, stored, 'cancelled', null);
    return Response.json({ ok: true, state: 'cancelled' });
  }

  // 3. CONFIRM — reconstruct + validate the action from the STORED payload (not the client).
  const action = KIND_TO_ACTION[stored.kind];
  if (!action) return Response.json({ error: 'Unsupported proposal.' }, { status: 400 });
  let body: z.infer<typeof ActionBody>;
  try {
    body = ActionBody.parse({ ...(stored.proposal as Record<string, unknown>), action });
  } catch (err) {
    log.error('ops-chat confirm: stored proposal failed validation', { err, proposalId: input.proposalId, kind: stored.kind });
    return Response.json({ error: 'This proposal can no longer be confirmed.' }, { status: 400 });
  }

  // 4. PRECHECK (before the CAS): tenant/current-access + admin, so a membership failure
  //    never strands a card in `confirming`.
  let ctx: TenantContext;
  try {
    ctx = await requireTenant(body.projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }
  try {
    requireAdmin(ctx.projectRole);
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 403 });
  }

  // Bounded anti-abuse guard on the write boundary (not a role/budget substitute).
  try {
    await getDb().transaction((tx) =>
      consumeRateLimit(tx, `ops-chat-confirm:user:${ctx.userId}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) return Response.json({ error: toPublicMessage(err) }, { status: 429 });
    log.error('ops-chat confirm rate-limit check failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }

  // 5. CAS pending→confirming — immediately before execution. Only one tab/device wins.
  const lock = await withUser({ userId: user.id }, (tx) =>
    transitionProposal(tx, user.id, { proposalId: input.proposalId, from: 'pending', to: 'confirming' }),
  );
  if (!lock) return Response.json({ error: 'This proposal is already being confirmed or is no longer pending.', state: stored.state }, { status: 409 });

  // 6. Execute, then CAS to the terminal state. The ACTION may be externally real (a PR
  //    merged, a deploy shipped), so we must never report a terminal state we did not persist:
  //    if the terminal CAS does not land, surface it as `unrecorded` rather than pretending.
  try {
    const executed = await runAction(body, ctx, input.proposalId);
    const done = await withUser({ userId: user.id }, (tx) =>
      transitionProposal(tx, user.id, { proposalId: input.proposalId, from: 'confirming', to: 'done', result: executed ?? null }),
    ).catch(() => null);
    if (!done) {
      log.error('ops-chat confirm: executed but failed to persist done state', { proposalId: input.proposalId, action: body.action });
      return Response.json({ ok: true, executed, state: 'unrecorded', warning: 'The action executed, but its card state could not be recorded — reload to see the true state.' });
    }
    await auditProposalLifecycle(ctx, stored, 'confirmed', executed);
    return Response.json({ ok: true, executed, state: 'done' });
  } catch (err) {
    const to = isStaleFailure(err) ? 'stale' : 'error';
    await auditProposalLifecycle(ctx, stored, to, null, toPublicMessage(err));
    if (!(err instanceof AppError)) log.error('ops-chat confirm execution failed', { err, action: body.action });
    const recorded = await withUser({ userId: user.id }, (tx) =>
      transitionProposal(tx, user.id, { proposalId: input.proposalId, from: 'confirming', to, error: toPublicMessage(err) }),
    ).catch((e) => {
      log.error('ops-chat confirm: failed to record terminal proposal state', { e, proposalId: input.proposalId });
      return null;
    });
    return Response.json(
      {
        error: toPublicMessage(err),
        state: recorded ? to : 'unrecorded',
        ...(recorded ? {} : { warning: 'The card state could not be recorded — reload to see the true state.' }),
      },
      { status: statusFor(err) },
    );
  }
}
