import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { startRun } from '@/domain/tasks/runner';

/**
 * POST — start a run and stream its progress as Server-Sent Events.
 *
 * Events:
 *   delta      { kind, text }              live model output for the running step
 *   step       { stepNumber, kind, succeeded, verdict, errorMessage }
 *   done       { runId, status, failureReason }
 *   run_error  { message }                 preflight/infrastructure failure
 *
 * The stream is OBSERVATIONAL. The run persists every step in its own
 * transaction regardless of whether anyone is still listening — a closed tab
 * never cancels or corrupts a run (runner.RunLiveEvents contract).
 *
 * POST, not GET: starting a run spends money; it must never be triggered by a
 * prefetch. EventSource can't POST, so the client reads the response body.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectKey: string; taskId: string }> },
): Promise<Response> {
  const { projectKey, taskId } = await params;
  if (!z.string().uuid().safeParse(taskId).success) {
    return Response.json({ error: 'Invalid task id.' }, { status: 400 });
  }

  // Auth resolves BEFORE the stream opens so failures are proper status codes.
  let ctx;
  try {
    ctx = await requireTenant(projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // client went away; the run continues regardless
        }
      };

      try {
        const outcome = await startRun(ctx, taskId, {
          delta: (kind, text) => send('delta', { kind, text }),
          step: (record) =>
            send('step', {
              stepNumber: record.stepNumber,
              kind: record.kind,
              succeeded: record.succeeded,
              verdict: record.verdict,
              errorMessage: record.errorMessage,
            }),
        });
        send('done', outcome);
      } catch (err) {
        if (!(err instanceof AppError)) log.error('streamed run failed', { err, taskId });
        send('run_error', { message: toPublicMessage(err) });
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
