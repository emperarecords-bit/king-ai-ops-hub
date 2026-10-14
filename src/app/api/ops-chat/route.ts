import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { getProvider } from '@/providers/registry';
import { getDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { buildPulse, pulseContext } from '@/domain/opschat/pulse';
import { createOpsChatToolset, proposalKey, type OpsChatProposal } from '@/domain/opschat/tools';
import {
  addProposal,
  appendAssistantMessage,
  appendOwnerMessage,
  conversationExists,
  createConversation,
  loadRecentTurnsForPrompt,
  loadReplyForOwnerMessage,
  type OpsChatMessageStatus,
} from '@/domain/opschat/conversations';
import { tryClaimTurn, type TurnClaim } from '@/domain/opschat/turn-claim';
import { type ToolLoopEvent } from '@/types/provider';
import {
  OPS_CHAT_MAX_PROMPT_MESSAGES,
  OPS_CHAT_PERSIST_FAILED_MESSAGE,
  OPS_CHAT_SERVER_DEADLINE_MS,
  OPS_CHAT_TIMEOUT_MESSAGE,
  OPS_CHAT_TURN_IN_PROGRESS_MESSAGE,
} from '@/domain/opschat/limits';

/**
 * POST — Ops Chat (chat-first front door). The model can call READ tools to fetch deeper
 * detail on demand and can PROPOSE an action — it NEVER writes: a proposal is a data object
 * surfaced for the owner to confirm. The single write path is POST /api/ops-chat/confirm.
 *
 * PERSISTENCE (PR 2): a conversation survives refresh / reopen / redeploy and resumes across
 * devices, because every turn is written to the user-scoped store, never kept only in client
 * React state. The turn protocol is built around a stable, client-minted `turnId`:
 *
 *   1. OWNER-FIRST — the owner message is committed (idempotently on `turnId`) BEFORE any
 *      provider work. A network retry re-sends the same `turnId`; the insert is a no-op and the
 *      route does NOT run the model twice.
 *   2. CLAIM — a Postgres advisory lock keyed on the owner message id serializes execution: at
 *      most one request runs the model for a given turn. The claim is released in `finally`.
 *   3. REPLAY — an already-persisted assistant reply (complete OR interrupted) is AUTHORITATIVE:
 *      a retry (or a loser of the claim) replays that exact reply and its proposals rather than
 *      creating a second reply. (reply_to_message_id links reply→owner; a DB unique index also
 *      guarantees at most one reply per owner turn.)
 *   4. COMMIT-THEN-SAVED — the assistant message AND its proposals are committed in ONE
 *      transaction; only then does the `saved` event deliver the {correlationKey → proposalId}
 *      mapping. A streamed proposal card carries only a correlationKey and is NOT actionable
 *      until `saved` supplies its id — so an actionable id is never emitted before it is
 *      persisted. If the transaction fails, NO `saved` is emitted and the cards stay disabled.
 *
 * PROVIDER-SPEND BOUNDARY: the landing pulse is deterministic ($0); THIS endpoint is the only
 * chat-provider boundary and keeps the owner-scoped per-user rate limit as the spend bound.
 *
 * Events (SSE):
 *   delta     { text }                              model output as produced (or full reply on replay)
 *   tool      { name, phase, ok? }                  a tool call started / finished (for UI)
 *   proposal  { ...OpsChatProposal, correlationKey } an action prepared for owner confirmation
 *   saved     { conversationId, messageId, status, proposals: [{correlationKey, proposalId}] }
 *   done      { }                                   reply complete
 *   error     { message }
 */

const OPS_CHAT_MODEL = 'claude-sonnet-5';

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  /** The conversation to append to; omitted starts a new one (created in the owner-commit tx). */
  conversationId: z.string().uuid().optional(),
  /** The client-minted, stable idempotency id for THIS send (the owner message id). A retry
   *  re-sends the same id so the turn is never duplicated and the model never re-runs. */
  turnId: z.string().uuid().optional(),
});

const SYSTEM_PROMPT = `You are the Ops Chat for the King AI Ops Hub — the owner's conversational front door to their multi-workspace AI operation. You speak to the owner directly.

You are given a LIVE snapshot of the hub below (what needs the owner, per-workspace health and activity, open questions). For anything the snapshot already answers, answer from it.

You also have TOOLS to fetch deeper detail on demand. Use them instead of saying "I don't have that":
- get_objective_criteria — an objective's actual success criteria (each with target + met/unmet) and what is blocking the unmet ones. Use for "what are the criteria?", "why isn't it done?", "what would finish it?".
- list_objectives, list_tasks, get_task_detail (run failure reason + failing step), list_open_questions, list_pending_approvals, get_approval_detail, list_agents.
- github_capabilities, list_github_repos, list_pull_requests, get_pull_request, get_workflow_run — read the workspace's governed GitHub capabilities and the linked repositories' pull-request + CI/check state and workflow-run state. Read-only.
- supabase_capabilities, list_supabase_projects, inspect_supabase_project, inspect_edge_functions, inspect_migrations — read a linked Supabase project's state: project info, edge functions (slug/status/version/verify_jwt), and applied migrations. Read-only. (A governed edge-function DEPLOY exists — see action 7.)
- validate_supabase_sql — DRY-RUN validate a single parameterized DML (INSERT/UPDATE/DELETE) against a linked project with a real SQL parser/AST allow-list. Read-only and side-effect-free. IMPORTANT: there is NO live approved-SQL execution — a DML is not provably reversible (destructive_irreversible), so the governed gate blocks it; this tool only validates and NEVER writes or prepares an executable proposal. Present its report and make clear live execution is unavailable. Never claim a SQL statement was run.
- vercel_capabilities, list_vercel_projects, inspect_vercel_project, inspect_vercel_deployments — read a linked Vercel project's state and its recent deployments: each deployment's production/preview target, state, source commit SHA + branch, created time, and inspector URL. Read-only (no redeploy/promote/rollback action exists yet).

You can help the owner take THREE kinds of action. Each PROPOSE tool only prepares a confirmation card — it never writes or runs anything. Never say something is saved/sent/decided/running; say it is "ready for you to confirm below."
1. ANSWER an owner-question: list_open_questions to find the id, draft the answer in the owner's voice, confirm the wording, then propose_answer_question.
2. APPROVE or REJECT a pending approval: list_pending_approvals (or get_approval_detail) to find the id and understand the action, confirm the owner's intent, then propose_decide_approval. When rejecting, always include a short rationale in the note — a refusal requires one.
3. DISPATCH WORK — start new work or re-run a task. This SPENDS money (an AI run uses tokens), so be deliberate and make sure the owner actually wants it. propose_dispatch_task creates a new task (give a clear title + instructions; use list_agents to choose who runs it, or omit to use the first agent); propose_rerun_task re-runs an existing task (e.g. retry a failed one — find it with list_tasks/get_task_detail first).
4. PREPARE A GITHUB PULL REQUEST — on a repository LINKED to the workspace, propose a new work branch + commit + pull request. Check github_capabilities / list_github_repos first (the repo must be linked and the executor enabled). The branch must be a NEW work branch (never the default/main branch), and EACH file must carry its COMPLETE intended content (never a placeholder, "...", or a summary of an edit). propose_github_pr prepares a confirm card and creates NOTHING until the owner confirms; on confirm it runs through the governed git_pr executor and returns the PR URL.
5. MERGE A PULL REQUEST — on a linked repo, propose merging an existing PR. First get_pull_request to read its exact head SHA and base branch; then propose_github_merge with the pr_number, expected_head_sha, and expected_base_branch. The governed executor refuses a draft, a closed/already-merged PR, a moved head (stale SHA), a base mismatch, or non-green CI, then squash-merges and verifies — returning the merge commit SHA. It creates NOTHING until the owner confirms.
6. RE-RUN A FAILED WORKFLOW — on a linked repo, propose re-running the FAILED jobs of a completed, failed GitHub Actions run. First get_workflow_run to read its exact run id, head SHA, and run attempt; then propose_github_rerun with run_id, expected_head_sha, and expected_run_attempt. The executor refuses anything that is not a completed+failed run with matching head/attempt, then uses the rerun-failed-jobs endpoint. It creates NOTHING until the owner confirms.
7. DEPLOY A SUPABASE EDGE FUNCTION — deploy ONE edge function to a LINKED Supabase project from the EXACT bytes of a LINKED GitHub repo at an immutable FULL commit SHA (40 hex — never a branch or short SHA). Check supabase_capabilities / list_supabase_projects (the project must be linked) and list_github_repos (the source repo must be linked). Use propose_supabase_deploy with project_ref, function_slug, source_repo, source_sha, source_path (the function's directory in the repo, e.g. "supabase/functions/<slug>"), and verify_jwt (set it deliberately). On confirm, the governed executor reads the source at that SHA, refuses an unlinked project/repo, a missing source path, a missing entrypoint, or an oversized bundle, deploys the exact bytes, and verifies the new version. Reversible by redeploying the prior SHA. It does NOT run SQL or migrations, and it deploys NOTHING until the owner confirms.
8. MUTATE A VERCEL DEPLOYMENT (redeploy / promote / rollback) — on a LINKED Vercel project, bound to EXACT deployment ids. First inspect_vercel_deployments to read the exact ids, their source SHAs, and the CURRENT production deployment id. Then: propose_vercel_redeploy (create a NEW non-production deployment from an exact source id + its SHA — does NOT move traffic); propose_vercel_promote (move PRODUCTION traffic to an exact READY target — bind target id + SHA + the current production id); propose_vercel_rollback (move PRODUCTION back to an exact previous production deployment — same bindings). The governed executor refuses an unlinked project, a non-READY or wrong-SHA target, a non-production rollback target, or a MOVED production pointer (stale), then performs exactly one operation and verifies production points where intended. promote/rollback MOVE LIVE PRODUCTION TRAFFIC — say so plainly. It changes NOTHING until the owner confirms.
To act on several at once (e.g. "approve all three", "answer both duplicates", "retry those tasks"), call the propose tool once per item — each becomes its own confirm card.

Rules:
- Be concise and plain-spoken. Lead with the answer. Use ONLY real data from the snapshot or tool results — never invent counts, names, criteria, or statuses.
- Do NOT speculate about connections between unrelated things (e.g. a bookkeeping question and an internal model-call error are not "the same issue" just because both involve the word "reconciliation"). Only link things the data actually links.
- Name the workspace when useful. Tools accept the workspace name or key.
- "FINISH THE RELEASE" requests (e.g. "finish the AccurateBids release", "finish the AccurateBids staging release"): do a BOUNDED, efficient inspection — NOT an exhaustive enumeration — so the turn stays fast and well within its time budget. Read only what the release decision needs: GitHub — the base branch's current HEAD + open PRs + the relevant CI; Supabase — project health + the specific function/migration state relevant to the release; Vercel — the current (staging or production) deployment + its source SHA. Then SYNTHESIZE ONCE and state plainly whether anything is actually required — a healthy, consistent release (e.g. the live deployment's source SHA already matches the base branch HEAD and nothing is pending) is a legitimate NO-OP; do not invent work. Do NOT enumerate large inventories (every edge function, every deployment) unless an inconsistency you already found requires deeper inspection. Still, any ACTION only ever prepares a confirm card and changes nothing until the owner confirms.`;

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

  // 1. OWNER-FIRST — commit the owner message BEFORE any provider work, idempotently on the
  //    client-minted turnId (a retry re-sends it → no-op, and the model never re-runs). A new
  //    conversation is created in the SAME transaction so a brand-new thread + its first
  //    message commit atomically. A conversationId that isn't the user's is a clean 404.
  const userId = auth.user.id;
  let conversationId: string;
  let ownerMessageId: string;
  try {
    const res = await withUser({ userId }, async (tx) => {
      let convId = body.conversationId;
      if (convId) {
        if (!(await conversationExists(tx, userId, convId))) throw new AppError('not_found', 'That conversation was not found.');
      } else {
        convId = (await createConversation(tx, userId)).id;
      }
      const owner = await appendOwnerMessage(tx, userId, { conversationId: convId, content: body.message, id: body.turnId });
      return { convId, ownerMessageId: owner.id };
    });
    conversationId = res.convId;
    ownerMessageId = res.ownerMessageId;
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      return Response.json({ error: toPublicMessage(err) }, { status: 404 });
    }
    if (!(err instanceof AppError)) log.error('ops-chat owner-message persist failed', { err });
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'conflict' ? 409 : 500 });
  }

  // Build the live pulse up front so an assembly failure is a clean error, not a half-open
  // stream. (The owner message is already committed; a pulse failure here just leaves the turn
  // with no reply yet — a retry replays nothing and re-runs, which is correct.)
  let system: string;
  try {
    const pulse = await buildPulse();
    system = `${SYSTEM_PROMPT}\n\n=== LIVE HUB SNAPSHOT (${new Date().toISOString()}) ===\n${pulseContext(pulse)}`;
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat pulse build failed', { err });
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }

  const toolset = createOpsChatToolset({ userId, projects: auth.projects, orgRoles: auth.orgRoles });

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

      // The client clears "Thinking…" on a `done` or `error` event. Track whether a terminal event has been
      // emitted so the `finally` can GUARANTEE one (while the client is still connected) even if the loop ever
      // exits a future way without emitting one — the UI must never be left pending.
      let sentTerminal = false;
      const sendTerminal = (event: 'done' | 'error', data: unknown): void => {
        sentTerminal = true;
        send(event, data);
      };

      // Commit the assistant reply + its proposals in ONE transaction, then return the
      // {correlationKey → proposalId} mapping. For an interrupted turn with NOTHING to keep
      // (no text, no proposals) we persist no row at all — an empty assistant bubble is noise,
      // and the owner message alone lets a retry re-run. The DB's one-reply-per-owner-turn
      // unique index means a second persist for the same turn fails closed (→ 'failed'), so a
      // duplicate reply can never be created even if two code paths raced here.
      type Saved = { kind: 'saved'; messageId: string; status: OpsChatMessageStatus; proposals: Array<{ correlationKey: string; proposalId: string }> } | { kind: 'skipped' } | { kind: 'failed' };
      const persistReply = async (status: OpsChatMessageStatus, content: string, props: readonly OpsChatProposal[]): Promise<Saved> => {
        if (status === 'interrupted' && content.trim() === '' && props.length === 0) return { kind: 'skipped' };
        try {
          return await withUser({ userId }, async (tx) => {
            const msg = await appendAssistantMessage(tx, userId, {
              conversationId,
              content,
              replyToMessageId: ownerMessageId,
              question: body.message,
              status,
            });
            const mapped: Array<{ correlationKey: string; proposalId: string }> = [];
            for (const p of props) {
              const row = await addProposal(tx, userId, { conversationId, messageId: msg.id, kind: p.kind, proposal: p });
              mapped.push({ correlationKey: proposalKey(p), proposalId: row.id });
            }
            return { kind: 'saved' as const, messageId: msg.id, status, proposals: mapped };
          });
        } catch (err) {
          log.error('ops-chat assistant persist failed', { err, ownerMessageId, status });
          return { kind: 'failed' };
        }
      };
      // Emit the proposal cards (each with its correlationKey) THEN the saved mapping. Order is
      // deliberate: a card is shown as the model proposed it, but only the saved mapping makes it
      // actionable (supplies the persisted proposalId). No saved ⇒ the client keeps cards disabled.
      const emitSaved = (saved: Extract<Saved, { kind: 'saved' }>, props: readonly OpsChatProposal[]): void => {
        for (const p of props) send('proposal', { ...p, correlationKey: proposalKey(p) });
        send('saved', { conversationId, messageId: saved.messageId, status: saved.status, proposals: saved.proposals });
      };

      let claim: TurnClaim | undefined;
      let ac: AbortController | undefined;
      let onReqAbort: (() => void) | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let iterator: AsyncIterator<ToolLoopEvent> | undefined;
      let assistantText = '';

      try {
        // 2. CLAIM the turn (serializes model execution per owner message).
        claim = await tryClaimTurn(ownerMessageId);

        // 3. REPLAY — an already-persisted reply is authoritative (even interrupted): replay it
        //    exactly and do NOT run the model. This covers both the idempotent retry and a loser
        //    of the claim whose winner already finished.
        const existing = await withUser({ userId }, (tx) => loadReplyForOwnerMessage(tx, userId, ownerMessageId));
        if (existing) {
          if (existing.content) send('delta', { text: existing.content });
          const mapped: Array<{ correlationKey: string; proposalId: string }> = [];
          for (const p of existing.proposals) {
            const stored = p.proposal as OpsChatProposal;
            const key = proposalKey(stored);
            send('proposal', { ...stored, correlationKey: key });
            mapped.push({ correlationKey: key, proposalId: p.id });
          }
          send('saved', { conversationId: existing.conversationId, messageId: existing.messageId, status: existing.status, proposals: mapped });
          sendTerminal('done', {});
          return;
        }

        // No reply yet, and we did NOT win the claim ⇒ another request is actively running this
        // turn. Never launch a duplicate provider turn; tell the client to reload shortly.
        if (!claim.claimed) {
          sendTerminal('error', { message: OPS_CHAT_TURN_IN_PROGRESS_MESSAGE });
          return;
        }

        // 4. RUN the model. We hold the claim and there is no persisted reply.
        //    Overall end-to-end deadline for the WHOLE request — every provider iteration AND
        //    every tool call. Racing each iterator step against this deadline means a stalled tool
        //    (runTool is not itself cancellable) still yields a clean, retryable timeout. Aborting
        //    also cancels any in-flight Anthropic call. The browser watchdog is the backstop.
        ac = new AbortController();
        const signal = ac.signal;
        onReqAbort = (): void => ac!.abort();
        if (req.signal) {
          if (req.signal.aborted) ac.abort();
          else req.signal.addEventListener('abort', onReqAbort, { once: true });
        }
        const TIMEOUT = Symbol('ops-chat-deadline');
        const deadline = new Promise<typeof TIMEOUT>((resolve) => {
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            ac!.abort();
            resolve(TIMEOUT);
          }, OPS_CHAT_SERVER_DEADLINE_MS);
        });

        // Bounded prompt history from the persisted store (ends with the owner message we just
        // committed) — the client never supplies conversation context.
        const turns = await withUser({ userId }, (tx) => loadRecentTurnsForPrompt(tx, userId, conversationId, OPS_CHAT_MAX_PROMPT_MESSAGES));

        // A completed model turn: commit the reply + proposals, then emit saved+done. A failed
        // transaction emits NO saved (client keeps cards disabled) and a retryable error; the
        // owner message stands, so a retry re-runs.
        const finishComplete = async (): Promise<void> => {
          const props = toolset.getProposals();
          const saved = await persistReply('complete', assistantText, props);
          if (saved.kind === 'saved') {
            emitSaved(saved, props);
            sendTerminal('done', {});
          } else {
            sendTerminal('error', { message: OPS_CHAT_PERSIST_FAILED_MESSAGE });
          }
        };

        const provider = getProvider('anthropic');
        if (!provider.streamWithTools) throw new Error('Tool-use is not available on this provider.');
        iterator = provider.streamWithTools(
          { model: OPS_CHAT_MODEL, system, turns, temperature: 0.3, maxOutputTokens: 1500, timeoutMs: 90_000, signal },
          toolset.tools,
          toolset.runTool,
        )[Symbol.asyncIterator]();

        for (;;) {
          const step = await Promise.race([iterator.next(), deadline]);
          if (step === TIMEOUT) {
            // Persist what the model produced before the deadline as an INTERRUPTED reply
            // (authoritative on a future reload/retry), then surface the retryable timeout.
            const props = toolset.getProposals();
            const saved = await persistReply('interrupted', assistantText, props);
            if (saved.kind === 'saved') emitSaved(saved, props);
            sendTerminal('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
            break;
          }
          if (step.done) {
            await finishComplete();
            break;
          }
          const ev = step.value;
          if (ev.kind === 'delta') {
            assistantText += ev.text;
            send('delta', { text: ev.text });
          } else if (ev.kind === 'tool_start') send('tool', { name: ev.name, phase: 'start' });
          else if (ev.kind === 'tool_end') send('tool', { name: ev.name, phase: 'end', ok: ev.ok });
          else if (ev.kind === 'done') {
            await finishComplete();
            break;
          }
        }
      } catch (err) {
        // The model loop threw. Preserve any partial output as an interrupted reply.
        const props = toolset.getProposals();
        if (timedOut) {
          const saved = await persistReply('interrupted', assistantText, props);
          if (saved.kind === 'saved') emitSaved(saved, props);
          sendTerminal('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
        } else if (ac?.signal.aborted) {
          // Client disconnected before the deadline — nothing to deliver, but still persist the
          // partial (best-effort) so a reconnect/reload replays it rather than losing the turn.
          await persistReply('interrupted', assistantText, props).catch(() => {});
        } else {
          if (!(err instanceof AppError)) log.error('ops-chat stream failed', { err });
          const saved = await persistReply('interrupted', assistantText, props);
          if (saved.kind === 'saved') emitSaved(saved, props);
          sendTerminal('error', { message: toPublicMessage(err) });
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (onReqAbort) req.signal?.removeEventListener('abort', onReqAbort);
        // GUARANTEE a terminal event: if the loop somehow exited without emitting one and the client is still
        // connected (not disconnected/aborted), emit a retryable error before closing so the UI never hangs.
        if (!sentTerminal && !ac?.signal.aborted) send('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        // Best-effort unwind of the provider generator (fire-and-forget; a generator stalled
        // inside a tool call is orphaned — it holds no write and is GC'd). Never awaited.
        void iterator?.return?.(undefined)?.catch(() => {});
        // Release the per-turn execution claim LAST, in finally, so success / timeout / provider
        // / tool failure all free it (and the reserved connection). A NOOP when we never claimed.
        await claim?.release();
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
