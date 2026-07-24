'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const KIND_LABEL: Record<string, string> = {
  primary: 'Primary',
  review: 'Review',
  revision: 'Revision',
  consolidate: 'Consolidate',
};

interface LiveSection {
  kind: string;
  text: string;
  done: boolean;
  succeeded: boolean | null;
}

/**
 * Starts the run via the SSE endpoint and renders live model output while it
 * streams. On completion the router refreshes so the server-rendered task page
 * (messages, steps, review panel) becomes the source of truth — the live view
 * is scaffolding, never the record.
 */
export function RunButton({
  projectKey,
  taskId,
  autorun,
  label,
}: {
  projectKey: string;
  taskId: string;
  autorun: boolean;
  label: string;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sections, setSections] = useState<LiveSection[]>([]);
  const fired = useRef(false);

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    setSections([]);
    try {
      const res = await fetch(
        `/api/p/${encodeURIComponent(projectKey)}/tasks/${encodeURIComponent(taskId)}/stream`,
        { method: 'POST' },
      );
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Run failed to start (HTTP ${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (event: string, data: Record<string, unknown>): void => {
        if (event === 'delta') {
          const kind = String(data.kind);
          const text = String(data.text);
          setSections((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.kind === kind && !last.done) {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { kind, text, done: false, succeeded: null }];
          });
        } else if (event === 'step') {
          const kind = String(data.kind);
          const succeeded = Boolean(data.succeeded);
          setSections((prev) => {
            const idx = prev.findIndex((s) => s.kind === kind && !s.done);
            if (idx === -1) {
              // Step produced no deltas (e.g. failed before first token).
              return [...prev, { kind, text: '', done: true, succeeded }];
            }
            const next = [...prev];
            next[idx] = { ...next[idx]!, done: true, succeeded };
            return next;
          });
        } else if (event === 'run_error') {
          setError(String(data.message ?? 'Run failed.'));
        }
        // 'done' needs no client handling: the refresh below renders the truth.
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventMatch = frame.match(/^event: (.+)$/m);
          const dataMatch = frame.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          try {
            handle(eventMatch[1]!, JSON.parse(dataMatch[1]!) as Record<string, unknown>);
          } catch {
            // A malformed frame is dropped; the post-run refresh shows the truth.
          }
        }
      }
    } catch {
      setError('Connection lost — the run continues on the server. Refresh to see its result.');
    } finally {
      setRunning(false);
      router.refresh();
    }
  }, [projectKey, taskId, router]);

  // Auto-start immediately after task creation (?autorun=1) — one shot only.
  useEffect(() => {
    if (autorun && !fired.current) {
      fired.current = true;
      void start();
    }
  }, [autorun, start]);

  return (
    <div>
      <button
        type="button"
        onClick={() => void start()}
        disabled={running}
        className="rounded-md bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {running ? 'Running…' : label}
      </button>

      {sections.length > 0 && running ? (
        <div className="mt-4 space-y-3">
          {sections.map((s, i) => (
            <div key={i} className="rounded-md border border-[var(--border)] p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                <span className="font-semibold text-[var(--foreground)]">
                  {KIND_LABEL[s.kind] ?? s.kind}
                </span>
                {s.done ? (
                  <span>{s.succeeded ? 'done' : 'failed'}</span>
                ) : (
                  <span className="animate-pulse">streaming…</span>
                )}
              </div>
              {s.text ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">{s.text}</pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
