import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { AppError } from '@/lib/errors';
import { WorkspaceNav } from './workspace-nav';

/**
 * Workspace shell. The rail is the workspace's table of contents (HUB-PRODUCT.md): a persistent
 * side rail grouped by the operating cycle. Identity (the workspace name) belongs to the shell,
 * not to any one page. The rail + breadcrumb both derive from nav-model, so location is answered
 * by the mental model. requireTenant() here is for early-redirect UX; every read below re-runs it.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;

  let name = projectKey;
  try {
    const ctx = await requireTenant(projectKey);
    const settings = await withTenant(ctx, (tx) => getWorkspaceSettings(tx, ctx));
    name = settings.name;
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthenticated') redirect('/login');
    redirect('/projects');
  }

  const base = `/p/${projectKey}`;

  return (
    // Stack on mobile (no fixed sidebar squeezing content → no horizontal overflow); side rail on md+.
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="w-full shrink-0 border-b border-[var(--border)] bg-[var(--surface)] p-3 md:w-56 md:border-b-0 md:border-r">
        <div className="mb-1 flex items-center gap-2 px-2 py-1">
          <span className="truncate text-sm font-semibold text-[var(--foreground)]" title={name}>
            {name}
          </span>
          <Link
            href="/projects"
            className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            switch
          </Link>
        </div>
        {/* The owner's cross-workspace Inbox is reachable from EVERY workspace, always. */}
        <Link
          href="/inbox"
          className="mb-3 block rounded-md border border-[var(--border)] px-2 py-1.5 text-sm font-semibold text-[var(--accent)] hover:border-[var(--accent)]"
        >
          Inbox
        </Link>
        {/* Mobile: a collapsed menu so the workspace nav never pushes content down or sideways. */}
        <details className="md:hidden">
          <summary className="cursor-pointer px-2 py-1 text-sm text-[var(--muted)]">Menu</summary>
          <div className="mt-2">
            <WorkspaceNav base={base} />
          </div>
        </details>
        {/* Desktop: the always-visible side rail. */}
        <div className="hidden md:block">
          <WorkspaceNav base={base} />
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
