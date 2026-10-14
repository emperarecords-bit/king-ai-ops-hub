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
  loadPromptTurns,
  loadReplyForOwnerMessage,
  type OpsChatMessageStatus,
} from '@/domain/opschat/conversations';
import { tryClaimConversation, tryClaimTurn, type TurnClaim } from '@/domain/opschat/turn-claim';
import { type ToolLoopEvent } from '@/types/provider';
import {
  OPS_CHAT_CONVERSATION_BUSY_MESSAGE,
  OPS_CHAT_INTERRUPTED_REPLAY_MESSAGE,
  OPS_CHAT_MAX_PROMPT_TURNS,
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
 * React state. The turn protocol is built around TWO stable, client-minted ids — a `conversationId`
 * (minted even for a brand-new conversation) and a `turnId` — so the EXACT same request can be
 * replayed after a total network failure with the same `(conversationId, turnId, content)`:
 *
 *   1. OWNER-FIRST — the conversation is created idempotently by its client id and the owner
 *      message is committed (idempotently on `turnId`) BEFORE any provider work. A retry re-sends
 *      the same ids; both inserts are no-ops and the route does NOT run the model twice. (Because
 *      the conversation id is client-stable, a first-turn retry can never fork a second conversation.)
 *   2. CLAIM (two scopes, both released in `finally`) — a per-TURN advisory lock keyed on the owner
 *      message id stops duplicate execution of the SAME send; a per-CONVERSATION advisory lock then
 *      stops two DIFFERENT owner messages in the same conversation (two tabs/devices) from executing
 *      at once and racing on prompt history. If the conversation is busy, the owner row stays
 *      persisted and the turn simply runs later.
 *   3. REPLAY (before any spend) — an already-persisted reply is AUTHORITATIVE and is replayed
 *      WITHOUT consuming provider budget or building a pulse: a complete reply replays text +
 *      proposals + `done`; an INTERRUPTED reply replays its partial text + `saved(interrupted,
 *      proposals:[])` + an `error` (never `done`, never actionable cards). The reply check sits
 *      AFTER the claim is acquired, so a reply that appeared around the claim race is still caught
 *      and the provider is never started on top of it.
 *   4. SPEND ONLY IN THE RUN BRANCH — rate limit and pulse build happen ONLY once we hold the
 *      claim and there is no reply to replay, so a persisted reply can never be made unreplayable
 *      by a rate limit or a transient pulse failure.
 *   5. COMMIT-THEN-SAVED — on a COMPLETE turn the assistant message AND its proposals commit in
 *      ONE transaction; only then does `saved` deliver the {correlationKey → proposalId} map. A
 *      streamed proposal carries only a correlationKey and is NOT actionable until `saved` supplies
 *      its id. If the transaction fails, NO `saved` is emitted and the cards stay disabled.
 *   6. INTERRUPTED NEVER ACTIONS — a timeout / provider error persists only the partial assistant
 *      TEXT (never any proposals: durable, actionable proposals exist only at a successful
 *      finalize), emits `saved(interrupted, proposals:[])`, and ends in `error`, never `done`.
 *
 * Events (SSE):
 *   delta     { text }                              model output as produced (or full/partial reply on replay)
 *   tool      { name, phase, ok? }                  a tool call started / finished (for UI)
 *   proposal  { ...OpsChatProposal, correlationKey } an action prepared for owner confirmation (complete turns only)
 *   saved     { conversationId, messageId, status, proposals: [{correlationKey, proposalId}] }
 *   done      { }                                   COMPLETE reply finished
 *   error     { message }                           timeout / failure / interrupted-reply replay
 */

const OPS_CHAT_MODEL = 'claude-sonnet-5';

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  /** The conversation to append to. REQUIRED and client-minted — even a brand-new conversation is
   *  created idempotently by this id, so a first-turn retry can never fork a second conversation. */
  conversationId: z.string().uuid(),
  /** REQUIRED, client-minted, stable idempotency id for THIS send (the owner message id). A retry
   *  re-sends the same id so the turn is never duplicated and the model never re-runs. (An optional
   *  id would weaken the guarantee to a convention, so it is mandatory at the route boundary.) */
  turnId: z.string().uuid(),
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

  // 1. OWNER-FIRST — commit the owner message BEFORE any provider work (and before the spend gate),
  //    idempotently on the client-minted ids. The conversation is created idempotently by its
  //    client id (onConflictDoNothing) so a first-turn retry can NEVER fork a second conversation;
  //    then ownership is verified (an id that belongs to another user → clean 404); then the owner
  //    message is appended idempotently on turnId. A retry re-sends the same ids → both inserts are
  //    no-ops and the model never re-runs. NOTE: the spend gate (rate limit) and pulse build happen
  //    later, only in the "we really will run the provider" branch — see the stream below — so a
  //    persisted reply can never be made unreplayable by a rate limit or a transient pulse failure.
  const userId = auth.user.id;
  const conversationId = body.conversationId;
  let ownerMessageId: string;
  try {
    ownerMessageId = await withUser({ userId }, async (tx) => {
      await createConversation(tx, userId, { id: conversationId }); // idempotent create by client id
      if (!(await conversationExists(tx, userId, conversationId))) {
        // The id exists but is not this user's (or the create was a no-op into another user's row).
        throw new AppError('not_found', 'That conversation was not found.');
      }
      const owner = await appendOwnerMessage(tx, userId, { conversationId, content: body.message, id: body.turnId });
      return owner.id;
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      return Response.json({ error: toPublicMessage(err) }, { status: 404 });
    }
    if (!(err instanceof AppError)) log.error('ops-chat owner-message persist failed', { err });
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'conflict' ? 409 : 500 });
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

      // Commit the assistant reply (+ its proposals, for a COMPLETE turn only) in ONE transaction,
      // then return the {correlationKey → proposalId} mapping.
      //
      // GOVERNANCE INVARIANT: durable, actionable proposals exist ONLY at a successful finalize.
      // An INTERRUPTED turn persists its partial TEXT for history but persists ZERO proposals —
      // an incomplete model turn must never create pending confirmation cards for governed writes.
      // (Enforced here regardless of what the caller passes.) An interrupted turn with no text at
      // all persists no row — an empty bubble is noise and the owner message alone lets a retry
      // re-run. The DB's one-reply-per-owner-turn unique index means a second persist for the same
      // turn fails closed (→ 'failed'), so a duplicate reply can never be created even if two code
      // paths raced here.
      type Saved = { kind: 'saved'; messageId: string; status: OpsChatMessageStatus; proposals: Array<{ correlationKey: string; proposalId: string }> } | { kind: 'skipped' } | { kind: 'failed' };
      const persistReply = async (status: OpsChatMessageStatus, content: string, props: readonly OpsChatProposal[]): Promise<Saved> => {
        const effectiveProps = status === 'complete' ? props : [];
        if (status === 'interrupted' && content.trim() === '') return { kind: 'skipped' };
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
            for (const p of effectiveProps) {
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
      let convClaim: TurnClaim | undefined;
      let ac: AbortController | undefined;
      let onReqAbort: (() => void) | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let iterator: AsyncIterator<ToolLoopEvent> | undefined;
      let assistantText = '';

      try {
        // 2. CLAIM the turn (serializes model execution per owner message).
        claim = await tryClaimTurn(ownerMessageId);

        // 3. REPLAY (before any spend) — an already-persisted reply is AUTHORITATIVE and is
        //    replayed WITHOUT consuming provider budget or building a pulse. Checking AFTER the
        //    claim is the double-check: a reply that landed around the claim race is still caught,
        //    so the provider is never started on top of an existing reply. A COMPLETE reply replays
        //    text + proposals + `done`; an INTERRUPTED reply replays its partial text +
        //    `saved(interrupted, proposals:[])` + `error` — it must NEVER masquerade as complete,
        //    so no `done` and no actionable cards.
        const existing = await withUser({ userId }, (tx) => loadReplyForOwnerMessage(tx, userId, ownerMessageId));
        if (existing) {
          if (existing.content) send('delta', { text: existing.content });
          if (existing.status === 'interrupted') {
            // Interrupted turns never persist proposals; replay an empty mapping regardless.
            send('saved', { conversationId: existing.conversationId, messageId: existing.messageId, status: 'interrupted', proposals: [] });
            sendTerminal('error', { message: OPS_CHAT_INTERRUPTED_REPLAY_MESSAGE });
          } else {
            const mapped: Array<{ correlationKey: string; proposalId: string }> = [];
            for (const p of existing.proposals) {
              const stored = p.proposal as OpsChatProposal;
              const key = proposalKey(stored);
              send('proposal', { ...stored, correlationKey: key });
              mapped.push({ correlationKey: key, proposalId: p.id });
            }
            send('saved', { conversationId: existing.conversationId, messageId: existing.messageId, status: existing.status, proposals: mapped });
            sendTerminal('done', {});
          }
          return;
        }

        // No reply yet, and we did NOT win the TURN claim ⇒ another request is actively running
        // this turn. Never launch a duplicate provider turn; tell the client to reload shortly.
        if (!claim.claimed) {
          sendTerminal('error', { message: OPS_CHAT_TURN_IN_PROGRESS_MESSAGE });
          return;
        }

        // 3b. CONVERSATION CLAIM — before the spend gate/provider loop, serialize execution across
        //     the whole conversation so two different owner messages (two tabs/devices) can't run at
        //     once and race on prompt history. If busy, the owner row stays persisted and the turn
        //     runs later on retry; we never start the provider.
        convClaim = await tryClaimConversation(conversationId);
        if (!convClaim.claimed) {
          sendTerminal('error', { message: OPS_CHAT_CONVERSATION_BUSY_MESSAGE });
          return;
        }

        // 4. SPEND GATE (only now that we hold both claims and there is no reply to replay). The
        //    tool loop makes one or more paid Anthropic calls; bound it with the per-user rate
        //    limiter. A persisted reply would have replayed above, so a rate limit can never make
        //    an already-saved reply unreplayable. Fail-closed on an unexpected limiter error.
        try {
          await getDb().transaction((tx) =>
            consumeRateLimit(tx, `ops-chat:user:${userId}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE),
          );
        } catch (err) {
          if (err instanceof RateLimitedError) {
            sendTerminal('error', { message: toPublicMessage(err) });
            return;
          }
          log.error('ops-chat rate-limit check failed', { err });
          sendTerminal('error', { message: 'Something went wrong.' });
          return;
        }

        // 5. Build the live pulse (also only in the run branch — a transient pulse failure must
        //    not make a persisted reply unreplayable; it just fails THIS run, retryably).
        let system: string;
        try {
          const pulse = await buildPulse();
          system = `${SYSTEM_PROMPT}\n\n=== LIVE HUB SNAPSHOT (${new Date().toISOString()}) ===\n${pulseContext(pulse)}`;
        } catch (err) {
          if (!(err instanceof AppError)) log.error('ops-chat pulse build failed', { err });
          sendTerminal('error', { message: toPublicMessage(err) });
          return;
        }

        // 6. RUN the model. We hold the claim, there is no persisted reply, spend is gated.
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

        // Turn-aware prompt history from the persisted store: owner turns in order, each followed by
        // its COMPLETE linked assistant reply, ending with the owner message we just committed.
        // Reconstructed by the owner→reply link (not raw seq), so an interleaved reply with a higher
        // seq than a later owner message is still attached to the right turn; interrupted output is
        // excluded. The client never supplies conversation context.
        const turns = await withUser({ userId }, (tx) => loadPromptTurns(tx, userId, conversationId, ownerMessageId, { maxOwnerTurns: OPS_CHAT_MAX_PROMPT_TURNS }));

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
            // Persist ONLY the partial assistant TEXT as an INTERRUPTED reply (no proposals —
            // an incomplete turn never produces actionable cards), then surface the retryable
            // timeout. saved carries proposals:[] and emits no proposal events.
            const saved = await persistReply('interrupted', assistantText, []);
            if (saved.kind === 'saved') emitSaved(saved, []);
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
        // The model loop threw. Preserve ONLY the partial assistant TEXT as an interrupted reply
        // (never proposals — an incomplete turn must not create actionable cards).
        if (timedOut) {
          const saved = await persistReply('interrupted', assistantText, []);
          if (saved.kind === 'saved') emitSaved(saved, []);
          sendTerminal('error', { message: OPS_CHAT_TIMEOUT_MESSAGE });
        } else if (ac?.signal.aborted) {
          // Client disconnected before the deadline — nothing to deliver, but still persist the
          // partial text (best-effort) so a reconnect/reload replays it rather than losing the turn.
          await persistReply('interrupted', assistantText, []).catch(() => {});
        } else {
          if (!(err instanceof AppError)) log.error('ops-chat stream failed', { err });
          const saved = await persistReply('interrupted', assistantText, []);
          if (saved.kind === 'saved') emitSaved(saved, []);
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
        // Release BOTH execution claims LAST, in finally, so success / timeout / provider / tool
        // failure all free them (and their reserved connections). Each is a NOOP when never claimed.
        // Conversation first, then turn (reverse of acquisition); both releases are idempotent.
        await convClaim?.release();
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
