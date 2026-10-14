/**
 * Ops Chat SSE consumer (browser side, but framework-free so it is unit-tested
 * in node). Parses the `event:`/`data:` stream from POST /api/ops-chat and drives
 * the supplied handlers.
 *
 * Why this exists separately: the UI must never hang on "Thinking…". This
 * consumer resolves the MOMENT the server sends `done` (or `error`) — it does NOT
 * wait for the underlying connection to close, which a proxy or a stalled server
 * can leave open indefinitely. On `done`/`error` it cancels the reader so the
 * socket is released promptly. A reader error (including an aborted fetch from
 * the browser watchdog) rejects, which the caller maps to its timeout/retry UI.
 *
 * It performs NO writes and surfaces no confirm/approve/dispatch action — those
 * only ever happen on an explicit user Confirm, through /api/ops-chat/confirm.
 */

import { OPS_CHAT_CONNECTION_CLOSED_MESSAGE } from '@/domain/opschat/limits';

export interface OpsChatStreamHandlers {
  onDelta(text: string): void;
  onToolStart(name: string): void;
  onToolEnd(): void;
  onProposal(proposal: Record<string, unknown>): void;
  /** The commit point: the reply (and, for a complete turn, its proposals) is persisted. Carries the
   *  {correlationKey → proposalId} mapping that makes streamed cards actionable. Arrives BEFORE the
   *  terminal `done` (complete) or `error` (interrupted). No `saved` ⇒ nothing terminal was recorded. */
  onSaved?(saved: OpsChatSaved): void;
}

export interface OpsChatSaved {
  conversationId: string;
  messageId: string;
  status: 'complete' | 'interrupted';
  proposals: Array<{ correlationKey: string; proposalId: string }>;
}

export type OpsChatStreamResult = { status: 'done' } | { status: 'error'; message: string };

export async function consumeOpsChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: OpsChatStreamHandlers,
): Promise<OpsChatStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Whatever happens, release the socket when we stop reading.
  const release = (): void => {
    try {
      // cancel() returns a promise that REJECTS if the stream errored — swallow it
      // so an aborted/errored read never produces an unhandled rejection.
      void reader.cancel().catch(() => {});
    } catch {
      /* already released */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // The stream closed WITHOUT an explicit `done`/`error` event. The server always emits one of those on a
        // normal finish or a timeout (and the consumer returns the instant it sees one, before reaching here), so
        // reaching this point means an ABNORMAL close (proxy cut, crashed server, a timeout whose terminal event
        // never arrived). Report a retryable failure — never a silent success — so the UI clears "Thinking…" and
        // tells the owner to try again. A timed-out request wrote nothing.
        return { status: 'error', message: OPS_CHAT_CONNECTION_CLOSED_MESSAGE };
      }
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }

        // A done event completes the request immediately — do NOT wait for close.
        if (event === 'done') {
          release();
          return { status: 'done' };
        }

        if (!data) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data);
        } catch {
          continue; // malformed data line — skip, never throw
        }

        if (event === 'delta' && typeof payload.text === 'string') {
          handlers.onDelta(payload.text);
        } else if (event === 'tool') {
          if (payload.phase === 'start' && typeof payload.name === 'string') handlers.onToolStart(payload.name);
          else if (payload.phase === 'end') handlers.onToolEnd();
        } else if (event === 'proposal') {
          handlers.onProposal(payload);
        } else if (event === 'saved') {
          // Malformed `saved` is ignored (cards then stay non-actionable) — never guessed.
          if (
            typeof payload.messageId === 'string' &&
            (payload.status === 'complete' || payload.status === 'interrupted') &&
            Array.isArray(payload.proposals)
          ) {
            handlers.onSaved?.({
              conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : '',
              messageId: payload.messageId,
              status: payload.status,
              proposals: (payload.proposals as unknown[]).flatMap((p) => {
                const r = p as Record<string, unknown> | null;
                return r && typeof r.correlationKey === 'string' && typeof r.proposalId === 'string'
                  ? [{ correlationKey: r.correlationKey, proposalId: r.proposalId }]
                  : [];
              }),
            });
          }
        } else if (event === 'error') {
          release();
          return { status: 'error', message: typeof payload.message === 'string' ? payload.message : 'The assistant hit an error.' };
        }
      }
    }
  } finally {
    // Ensure the reader is released on any exit path (return or throw/abort).
    release();
  }
}
