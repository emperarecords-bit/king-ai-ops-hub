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
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-3 flex items-center gap-2 px-2 py-1">
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
        <WorkspaceNav base={base} />
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl p-6">{children}</div>
      </main>
    </div>
  );
}
