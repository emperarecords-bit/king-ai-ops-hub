import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { getProvider } from '@/providers/registry';
import { getDb } from '@/db/client';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { buildPulse, pulseContext } from '@/domain/opschat/pulse';
import { createOpsChatToolset } from '@/domain/opschat/tools';
import { type ToolLoopEvent } from '@/types/provider';
import { OPS_CHAT_SERVER_DEADLINE_MS, OPS_CHAT_TIMEOUT_MESSAGE } from '@/domain/opschat/limits';

/**
 * POST — Ops Chat (chat-first front door). v2: the model can call READ tools to
 * fetch deeper detail on demand (objective criteria + blockers, run failures,
 * tasks, open questions, pending approvals, agents) and can PROPOSE an action —
 * answer an owner-question, decide an approval, or dispatch/re-run work. It
 * NEVER writes: a proposal is a data object surfaced for the owner to confirm.
 * The single write path is POST /api/ops-chat/confirm, which re-validates and
 * re-enters tenant context (the model cannot call the write functions).
 *
 * PROVIDER-SPEND BOUNDARY (preserved from v1, and more important in v2):
 *   - The landing page opens with a DETERMINISTIC pulse — no provider call, $0.
 *   - THIS endpoint is the only chat-provider boundary. v2 can cost MORE than
 *     v1 (a multi-turn tool loop: several model round-trips per Send), so the
 *     v1 owner-scoped per-user rate limit is KEPT here, unchanged, as the spend
 *     bound. Sending a question incurs Anthropic usage; the UI says so.
 *   - Confirming a dispatch/re-run can START real, spend-producing work — that
 *     spend is governed by the existing task/run budget + rate machinery on the
 *     execution path, not here.
 *
 * Events (SSE):
 *   delta     { text }                  model output as produced
 *   tool      { name, phase, ok? }      a tool call started / finished (for UI)
 *   proposal  { ...OpsChatProposal }    an action prepared for owner confirmation
 *   done      { }                       reply complete
 *   error     { message }
 */

const OPS_CHAT_MODEL = 'claude-sonnet-5';

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(20)
    .optional(),
});

const SYSTEM_PROMPT = `You are the Ops Chat for the King AI Ops Hub — the owner's conversational front door to their multi-workspace AI operation. You speak to the owner directly.

You are given a LIVE snapshot of the hub below (what needs the owner, per-workspace health and activity, open questions). For anything the snapshot already answers, answer from it.

You also have TOOLS to fetch deeper detail on demand. Use them instead of saying "I don't have that":
- get_objective_criteria — an objective's actual success criteria (each with target + met/unmet) and what is blocking the unmet ones. Use for "what are the criteria?", "why isn't it done?", "what would finish it?".
- list_objectives, list_tasks, get_task_detail (run failure reason + failing step), list_open_questions, list_pending_approvals, get_approval_detail, list_agents.
- github_capabilities, list_github_repos, list_pull_requests, get_pull_request, get_workflow_run — read the workspace's governed GitHub capabilities and the linked repositories' pull-request + CI/check state and workflow-run state. Read-only.
- supabase_capabilities, list_supabase_projects, inspect_supabase_project, inspect_edge_functions, inspect_migrations — read a linked Supabase project's state: project info, edge functions (slug/status/version/verify_jwt), and applied migrations. Read-only (no Supabase deploy/SQL action exists yet).

You can help the owner take THREE kinds of action. Each PROPOSE tool only prepares a confirmation card — it never writes or runs anything. Never say something is saved/sent/decided/running; say it is "ready for you to confirm below."
1. ANSWER an owner-question: list_open_questions to find the id, draft the answer in the owner's voice, confirm the wording, then propose_answer_question.
2. APPROVE or REJECT a pending approval: list_pending_approvals (or get_approval_detail) to find the id and understand the action, confirm the owner's intent, then propose_decide_approval. When rejecting, always include a short rationale in the note — a refusal requires one.
3. DISPATCH WORK — start new work or re-run a task. This SPENDS money (an AI run uses tokens), so be deliberate and make sure the owner actually wants it. propose_dispatch_task creates a new task (give a clear title + instructions; use list_agents to choose who runs it, or omit to use the first agent); propose_rerun_task re-runs an existing task (e.g. retry a failed one — find it with list_tasks/get_task_detail first).
4. PREPARE A GITHUB PULL REQUEST — on a repository LINKED to the workspace, propose a new work branch + commit + pull request. Check github_capabilities / list_github_repos first (the repo must be linked and the executor enabled). The branch must be a NEW work branch (never the default/main branch), and EACH file must carry its COMPLETE intended content (never a placeholder, "...", or a summary of an edit). propose_github_pr prepares a confirm card and creates NOTHING until the owner confirms; on confirm it runs through the governed git_pr executor and returns the PR URL.
5. MERGE A PULL REQUEST — on a linked repo, propose merging an existing PR. First get_pull_request to read its exact head SHA and base branch; then propose_github_merge with the pr_number, expected_head_sha, and expected_base_branch. The governed executor refuses a draft, a closed/already-merged PR, a moved head (stale SHA), a base mismatch, or non-green CI, then squash-merges and verifies — returning the merge commit SHA. It creates NOTHING until the owner confirms.
6. RE-RUN A FAILED WORKFLOW — on a linked repo, propose re-running the FAILED jobs of a completed, failed GitHub Actions run. First get_workflow_run to read its exact run id, head SHA, and run attempt; then propose_github_rerun with run_id, expected_head_sha, and expected_run_attempt. The executor refuses anything that is not a completed+failed run with matching head/attempt, then uses the rerun-failed-jobs endpoint. It creates NOTHING until the owner confirms.
To act on several at once (e.g. "approve all three", "answer both duplicates", "retry those tasks"), call the propose tool once per item — each becomes its own confirm card.

Rules:
- Be concise and plain-spoken. Lead with the answer. Use ONLY real data from the snapshot or tool results — never invent counts, names, criteria, or statuses.
- Do NOT speculate about connections between unrelated things (e.g. a bookkeeping question and an internal model-call error are not "the same issue" just because both involve the word "reconciliation"). Only link things the data actually links.
- Name the workspace when useful. Tools accept the workspace name or key.`;

export async function POST(req: Request): Promise<Response> {
  // Auth resolves BEFORE the stream opens so failures are proper status codes.
  let auth: Awaited<ReturnType<typeof listMyProjectsWithOrgRoles>>;
  try {
    await requireUser();
    auth = await listMyProjectsWithOrgRoles();
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Provider-spend gate (preserved from v1): this request is about to make one
  // or more paid Anthropic calls (tool loop), so bound it with the existing
  // per-user rate limiter BEFORE any provider work. Fail-closed: an unexpected
  // limiter error is a 500, not a silent pass to the model.
  try {
    await getDb().transaction((tx) =>
      consumeRateLimit(tx, `ops-chat:user:${auth.user.id}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return Response.json({ error: toPublicMessage(err) }, { status: 429 });
    }
    log.error('ops-chat rate-limit check failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }

  // Build the live pulse up front so an assembly failure is a clean error, not
  // a half-open stream.
  let system: string;
  try {
    const pulse = await buildPulse();
    system = `${SYSTEM_PROMPT}\n\n=== LIVE HUB SNAPSHOT (${new Date().toISOString()}) ===\n${pulseContext(pulse)}`;
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat pulse build failed', { err });
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }

  const turns = [
    ...(body.history ?? []).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: body.message },
  ];

  const toolset = createOpsChatToolset({ userId: auth.user.id, projects: auth.projects, orgRoles: auth.orgRoles });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Overall end-to-end deadline for the WHOLE request — every provider
      // iteration AND every tool call — independent of the per-call provider
      // timeout and of how many tool-loop iterations run. Racing each iterator
      // step against this deadline means a stalled tool (runTool is not itself
      // cancellable) still yields a clean, retryable timeout rather than an
      // open-forever stream. Aborting also cancels any in-flight Anthropic call.
      // The browser watchdog is the backstop.
      const ac = new AbortController();
      const onReqAbort = (): void => ac.abort();
      if (req.signal) {
        if (req.signal.aborted) ac.abort();
        else req.signal.addEventListener('abort', onReqAbort, { once: true });
      }
      let timedOut = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const TIMEOUT = Symbol('ops-chat-deadline');
      const deadline = new Promise<typeof TIMEOUT>((resolve) => {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          ac.abort();
          resolve(TIMEOUT);
        }, OPS_CHAT_SERVER_DEADLINE_MS);
      });

      const finalize = (): void => {
        for (const proposal of toolset.getProposals()) send('proposal', proposal);
        send('done', {});
      };

      let iterator: AsyncIterator<ToolLoopEvent> | undefined;
      try {
        const provider = getProvider('anthropic');
        if (!provider.streamWithTools) throw new Error('Tool-use is not available on this provider.');
        iterator = provider.streamWithTools(
          { model: OPS_CHAT_MODEL, system, turns, temperature: 0.3, maxOutputTokens: 1500, timeoutMs: 90_000, signal: ac.signal },
          toolset.tools,
          toolset.runTool,
        )[Symbol.asyncIterator]();

        for (;;) {
          const step = await Promise.race([iterator.next(), deadline]);
          if (step === TIMEOUT) {
            send('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
            break;
          }
          if (step.done) {
            finalize();
            break;
          }
          const ev = step.value;
          if (ev.kind === 'delta') send('delta', { text: ev.text });
          else if (ev.kind === 'tool_start') send('tool', { name: ev.name, phase: 'start' });
          else if (ev.kind === 'tool_end') send('tool', { name: ev.name, phase: 'end', ok: ev.ok });
          else if (ev.kind === 'done') {
            finalize();
            break;
          }
        }
      } catch (err) {
        if (timedOut) {
          send('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
        } else if (ac.signal.aborted) {
          // Client disconnected before the deadline — nothing to deliver.
        } else {
          if (!(err instanceof AppError)) log.error('ops-chat stream failed', { err });
          send('error', { message: toPublicMessage(err) });
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        req.signal?.removeEventListener('abort', onReqAbort);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        // Best-effort unwind of the provider generator (fire-and-forget; a
        // generator stalled inside a tool call is orphaned — it holds no write
        // and is GC'd). Never awaited, so a stuck tool cannot block closing.
        void iterator?.return?.(undefined)?.catch(() => {});
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
