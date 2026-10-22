/**
 * A 200 JSON response for slow work: it writes a space every `everyMs` until `work` settles, then the JSON body
 * (the work's result, or `onError(err)`). Leading whitespace is valid JSON, so `await res.json()` reads it as usual;
 * the bytes keep any proxy from closing a quiet connection while reasoning models think (Council, 2026-10-22).
 */
export function heartbeatJson(work: () => Promise<unknown>, everyMs: number, onError: (err: unknown) => unknown): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string): void => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* the client went away — the work itself is aborted through the request signal */
        }
      };
      timer = setInterval(() => write(' '), everyMs);
      let payload: unknown;
      try {
        payload = await work();
      } catch (err) {
        payload = onError(err);
      } finally {
        stop();
      }
      write(JSON.stringify(payload));
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel: stop,
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}
