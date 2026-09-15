import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { getProvider } from '@/providers/registry';
import { buildPulse, pulseContext } from '@/domain/opschat/pulse';
import { createOpsChatToolset } from '@/domain/opschat/tools';

/**
 * POST — Ops Chat (chat-first front door). v2: the model can call READ tools to
 * fetch deeper detail on demand (objective criteria + blockers, run failures,
 * tasks, open questions) and can PROPOSE an answer to an owner-question — which
 * it never writes itself; a proposal is surfaced for the owner to confirm (the
 * confirm endpoint performs the one write, re-validated via answerOwnerQuestion).
 *
 * Events (SSE):
 *   delta     { text }                  model output as produced
 *   tool      { name, phase, ok? }      a tool call started / finished (for UI)
 *   proposal  { questionId, projectKey, workspaceName, question, answer }
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
- list_objectives, list_tasks, get_task_detail (run failure reason + failing step), list_open_questions, list_pending_approvals, get_approval_detail.

You can help the owner take TWO kinds of action. Each PROPOSE tool only prepares a confirmation card — it never writes. Never say something is saved/sent/decided; say it is "ready for you to confirm below."
1. ANSWER an owner-question: list_open_questions to find the id, draft the answer in the owner's voice, confirm the wording, then propose_answer_question.
2. APPROVE or REJECT a pending approval: list_pending_approvals (or get_approval_detail) to find the id and understand the action, confirm the owner's intent, then propose_decide_approval. When rejecting, always include a short rationale in the note — a refusal requires one.
To act on several at once (e.g. "approve all three", "answer both duplicates"), call the propose tool once per item — each becomes its own confirm card.

Rules:
- Be concise and plain-spoken. Lead with the answer. Use ONLY real data from the snapshot or tool results — never invent counts, names, criteria, or statuses.
- Do NOT speculate about connections between unrelated things (e.g. a bookkeeping question and an internal model-call error are not "the same issue" just because both involve the word "reconciliation"). Only link things the data actually links.
- Name the workspace when useful. Tools accept the workspace name or key.
- You cannot dispatch or run new work yet (that's coming) — only look things up, answer questions, and decide approvals, each via confirmation. If asked to dispatch work, say so plainly.`;

export async function POST(req: Request): Promise<Response> {
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

      try {
        const provider = getProvider('anthropic');
        if (!provider.streamWithTools) throw new Error('Tool-use is not available on this provider.');
        for await (const ev of provider.streamWithTools(
          { model: OPS_CHAT_MODEL, system, turns, temperature: 0.3, maxOutputTokens: 1500, timeoutMs: 90_000, signal: req.signal },
          toolset.tools,
          toolset.runTool,
        )) {
          if (ev.kind === 'delta') send('delta', { text: ev.text });
          else if (ev.kind === 'tool_start') send('tool', { name: ev.name, phase: 'start' });
          else if (ev.kind === 'tool_end') send('tool', { name: ev.name, phase: 'end', ok: ev.ok });
        }
        for (const proposal of toolset.getProposals()) send('proposal', proposal);
        send('done', {});
      } catch (err) {
        if (!(err instanceof AppError)) log.error('ops-chat stream failed', { err });
        send('error', { message: toPublicMessage(err) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
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
