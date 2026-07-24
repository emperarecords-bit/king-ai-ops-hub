import Link from 'next/link';

/**
 * Small shared presentational pieces. Server-component-safe (no hooks).
 * All model/task content rendered through these lands in text nodes — never
 * innerHTML (SECURITY.md T6).
 */

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 ${className}`}
    >
      {title ? (
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-[#2a3247] text-[var(--info)]',
  running: 'bg-[#3a3420] text-[var(--accent-strong)]',
  awaiting_approval: 'bg-[#3a2c20] text-[var(--accent)]',
  completed: 'bg-[#1f3a2a] text-[var(--success)]',
  failed: 'bg-[#3a2026] text-[var(--danger)]',
  cancelled: 'bg-[#2a2a2a] text-[var(--muted)]',
  approved: 'bg-[#1f3a2a] text-[var(--success)]',
  rejected: 'bg-[#3a2026] text-[var(--danger)]',
  expired: 'bg-[#2a2a2a] text-[var(--muted)]',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-[#2a3247] text-[var(--muted)]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${style}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function ProviderBadge({ provider }: { provider: string }) {
  const style =
    provider === 'openai'
      ? 'border-[#3d6b58] text-[#74c3a4]'
      : provider === 'anthropic'
        ? 'border-[#6b5a3d] text-[#d4a843]'
        : 'border-[var(--border)] text-[var(--muted)]';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${style}`}>{provider}</span>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">
      {children}
    </p>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--foreground)]"
    >
      {children}
    </Link>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-[var(--background)]">
      <div
        className="h-full rounded bg-[var(--accent)] transition-all"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

/** Pre-wrapped monospace block for model output. Text nodes only. */
export function ModelText({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md bg-[var(--background)] p-4 font-mono text-sm leading-relaxed text-[var(--foreground)]">
      {content}
    </pre>
  );
}
