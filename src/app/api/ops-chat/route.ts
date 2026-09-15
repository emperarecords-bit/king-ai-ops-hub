import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser } from '@/domain/auth/guard';
import { getProvider } from '@/providers/registry';
import { buildPulse, pulseContext } from '@/domain/opschat/pulse';

/**
 * POST — Ops Chat (chat-first front door, v1 READ-ONLY).
 *
 * Answers the owner's free-form question from the LIVE hub pulse, streamed as
 * Server-Sent Events so the reply appears word-by-word (like a real chat).
 *
 * Events:
 *   delta  { text }     model output as it is produced
 *   done   { }          the reply is complete
 *   error  { message }  auth/preflight/model failure
 *
 * v1 is strictly read-only: it summarizes and explains, it never changes hub
 * state. (Answering questions / approving / dispatching is v2.)
 */

// Reliable for our small, live context. One-line swap to 'claude-opus-4-8' if
// answers ever come back empty on a larger prompt (see hub execution notes).
const OPS_CHAT_MODEL = 'claude-sonnet-5';

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(8000),
      }),
    )
    .max(20)
    .optional(),
});

const SYSTEM_PROMPT = `You are the Ops Chat for the King AI Ops Hub — the owner's conversational front door to their multi-workspace AI operation. You speak to the owner directly.

You are given a LIVE snapshot of the hub below (what needs the owner, per-workspace health and activity, open questions). Answer the owner's question using ONLY that snapshot.

Rules:
- Be concise and plain-spoken. Lead with the answer. Short paragraphs or tight bullet lists; no preamble like "Great question".
- Use ONLY the numbers and facts in the snapshot. Never invent counts, names, or statuses. If the snapshot does not contain the answer, say so plainly and suggest where in the hub to look (name the workspace).
- This is a READ-ONLY assistant. You cannot answer owner-questions, approve anything, dispatch work, or change any state. If the owner asks you to DO one of those, explain that acting-by-chat is coming soon and, for now, point them to the right place (e.g. "open the Inbox to approve those").
- Prefer the owner's plain words ("what needs me", "how's AccurateBids") over internal jargon. When useful, mention the workspace name so they know where to go.
- If nothing needs the owner, reassure them briefly rather than manufacturing concerns.`;

export async function POST(req: Request): Promise<Response> {
  // Auth resolves BEFORE the stream opens so failures are proper status codes.
  try {
    await requireUser();
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
        if (!provider.stream) throw new Error('Streaming is not available.');
        for await (const ev of provider.stream({
          model: OPS_CHAT_MODEL,
          system,
          turns,
          temperature: 0.3,
          maxOutputTokens: 1200,
          timeoutMs: 60_000,
          signal: req.signal,
        })) {
          if (ev.kind === 'delta') send('delta', { text: ev.text });
        }
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
