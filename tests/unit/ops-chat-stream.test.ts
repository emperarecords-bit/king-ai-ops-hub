import { describe, expect, it } from 'vitest';
import { consumeOpsChatStream, type OpsChatStreamHandlers } from '@/app/ops/ops-chat-stream';

/**
 * Ops Chat SSE consumer. Node-level regression tests for the browser stream
 * reader: it must complete the instant the server sends `done` (even if the
 * connection is left open), surface an error event, and tolerate malformed data
 * without hanging or throwing.
 */

function sseStream(chunks: string[], opts: { leaveOpen?: boolean } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!opts.leaveOpen) controller.close();
      // leaveOpen: never close — the consumer must still finish on `done`.
    },
  });
}

function handlers(): OpsChatStreamHandlers & {
  deltas: string[];
  tools: string[];
  toolEnds: number;
  proposals: Record<string, unknown>[];
} {
  const deltas: string[] = [];
  const tools: string[] = [];
  const proposals: Record<string, unknown>[] = [];
  let toolEnds = 0;
  return {
    deltas,
    tools,
    proposals,
    get toolEnds() {
      return toolEnds;
    },
    onDelta: (t) => deltas.push(t),
    onToolStart: (n) => tools.push(n),
    onToolEnd: () => {
      toolEnds++;
    },
    onProposal: (p) => proposals.push(p),
  };
}

const ev = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('consumeOpsChatStream', () => {
  it('normal completion: delta + tool + proposal + done → {done}, handlers fired', async () => {
    const h = handlers();
    const stream = sseStream([
      ev('delta', { text: 'Hello' }),
      ev('tool', { name: 'list_tasks', phase: 'start' }),
      ev('tool', { name: 'list_tasks', phase: 'end', ok: true }),
      ev('proposal', { kind: 'answer_question', questionId: 'q1' }),
      ev('done', {}),
    ]);
    const result = await consumeOpsChatStream(stream, h);
    expect(result).toEqual({ status: 'done' });
    expect(h.deltas).toEqual(['Hello']);
    expect(h.tools).toEqual(['list_tasks']);
    expect(h.toolEnds).toBe(1);
    expect(h.proposals).toHaveLength(1);
  });

  it('server `done` with the connection LEFT OPEN still completes immediately (no hang)', async () => {
    const h = handlers();
    // Stream sends a delta + done, then never closes. The consumer must resolve.
    const stream = sseStream([ev('delta', { text: 'hi' }), ev('done', {})], { leaveOpen: true });
    const result = await consumeOpsChatStream(stream, h);
    expect(result).toEqual({ status: 'done' });
    expect(h.deltas).toEqual(['hi']);
  });

  it('error event → {error, message} and stops', async () => {
    const h = handlers();
    const stream = sseStream([ev('delta', { text: 'partial' }), ev('error', { message: 'boom' })], { leaveOpen: true });
    const result = await consumeOpsChatStream(stream, h);
    expect(result).toEqual({ status: 'error', message: 'boom' });
    expect(h.deltas).toEqual(['partial']);
  });

  it('malformed data line is skipped, not thrown — stream still completes', async () => {
    const h = handlers();
    const stream = sseStream([
      'event: delta\ndata: {not valid json}\n\n',
      ev('delta', { text: 'ok' }),
      ev('done', {}),
    ]);
    const result = await consumeOpsChatStream(stream, h);
    expect(result).toEqual({ status: 'done' });
    expect(h.deltas).toEqual(['ok']); // malformed one skipped
  });

  it('clean close with no done/error → benign {done} (UI never left pending)', async () => {
    const h = handlers();
    const stream = sseStream([ev('delta', { text: 'x' })]); // closes, no done
    const result = await consumeOpsChatStream(stream, h);
    expect(result).toEqual({ status: 'done' });
  });

  it('a reader error (e.g. aborted fetch) rejects so the caller can show its timeout UI', async () => {
    const h = handlers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException('aborted', 'AbortError'));
      },
    });
    await expect(consumeOpsChatStream(stream, h)).rejects.toBeTruthy();
  });
});
