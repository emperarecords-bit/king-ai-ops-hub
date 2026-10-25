'use client';

import { type ConversationPanel, type PanelJob } from './ops-chat-panel-model';

/** This conversation's Ops Chat spend (from ops_chat_usage; serialisable — micros as a string). */
export interface PanelUsage {
  turns: number;
  webSearches: number;
  costMicros: string;
}

const TONE: Record<PanelJob['state'], string> = {
  starting: 'text-[var(--muted)]',
  queued: 'text-[var(--muted)]',
  running: 'text-[var(--accent)]',
  ready: 'text-[#7bd88f]',
  draft: 'text-[#e5c07b]',
  needs_approval: 'text-[#e5c07b]',
  failed: 'text-[var(--danger)]',
  no_run: 'text-[var(--muted)]',
};

function dollars(micros: string): string {
  const n = Number(micros) / 1e6;
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--border)] pb-3">
      <h2 className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        <span>{title}</span>
        {count != null && count > 0 ? <span className="rounded-full border border-[var(--border)] px-1.5 text-[10px]">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[var(--muted)]">{children}</p>;
}

/**
 * Right panel on extra-wide screens: what this conversation has set in motion. Everything comes from the cards
 * already on screen (kept live by the linked-run refresh), plus this conversation's usage loaded with the page.
 */
export function OpsChatContextPanel({ panel, usage }: { panel: ConversationPanel; usage: PanelUsage | null }) {
  return (
    <aside aria-label="This conversation" className="flex h-full flex-col gap-3 overflow-y-auto pr-1 text-sm">
      <p className="text-xs font-semibold text-[var(--foreground)]">This conversation</p>

      <Section title="Needs you" count={panel.needsYou.length}>
        {panel.needsYou.length === 0 ? (
          <Empty>Nothing waiting on you here.</Empty>
        ) : (
          <ul className="space-y-1">
            {panel.needsYou.map((n) => (
              <li key={n.key} className="text-xs">
                {n.anchor ? (
                  <a href={n.anchor} className="text-[#e5c07b] underline-offset-2 hover:underline">
                    {n.label}
                  </a>
                ) : (
                  <span className="text-[#e5c07b]">{n.label}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Jobs" count={panel.jobs.length}>
        {panel.jobs.length === 0 ? (
          <Empty>No jobs started from this chat yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {panel.jobs.map((j) => (
              <li key={j.key} data-testid="panel-job" className="text-xs">
                {j.href ? (
                  <a href={j.href} className="line-clamp-2 text-[var(--foreground)] underline-offset-2 hover:underline" title={j.label}>
                    {j.label}
                  </a>
                ) : (
                  <span className="line-clamp-2" title={j.label}>
                    {j.label}
                  </span>
                )}
                <span className={`block ${TONE[j.state]}`}>
                  {j.stateLabel}
                  {j.notFound.length > 0 ? ` · ${j.notFound.length} item${j.notFound.length === 1 ? '' : 's'} not found` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Results" count={panel.results.length}>
        {panel.results.length === 0 ? (
          <Empty>Finished answers will appear here.</Empty>
        ) : (
          <ul className="space-y-1">
            {panel.results.map((j) => (
              <li key={j.key} className="text-xs">
                {j.href ? (
                  <a href={j.href} className="text-[var(--accent)] underline-offset-2 hover:underline" title={j.label}>
                    {j.label}
                  </a>
                ) : (
                  <span>{j.label}</span>
                )}
                {j.state === 'draft' ? <span className="text-[#e5c07b]"> (unreviewed)</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decisions recorded" count={panel.decisions.length}>
        {panel.decisions.length === 0 ? (
          <Empty>None in this chat.</Empty>
        ) : (
          <ul className="space-y-1">
            {panel.decisions.map((d) => (
              <li key={d.key} className="text-xs text-[var(--muted)]">
                {d.anchor ? (
                  <a href={d.anchor} className="hover:text-[var(--foreground)]">
                    {d.label}
                  </a>
                ) : (
                  d.label
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <section>
        <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Usage</h2>
        {usage && usage.turns > 0 ? (
          <p className="text-xs text-[var(--muted)]">
            <span className="text-[var(--foreground)]">{dollars(usage.costMicros)}</span> · {usage.turns} repl{usage.turns === 1 ? 'y' : 'ies'} ·{' '}
            {usage.webSearches} web search{usage.webSearches === 1 ? '' : 'es'}
          </p>
        ) : (
          <Empty>No recorded replies yet.</Empty>
        )}
        <p className="mt-1 text-[10px] text-[var(--muted)]">As of page load. Not counted toward any workspace limit.</p>
      </section>
    </aside>
  );
}
