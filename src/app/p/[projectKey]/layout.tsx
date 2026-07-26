import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { AppError } from '@/lib/errors';
import { RailLink } from './rail';

/**
 * Workspace shell. The rail is the workspace's table of contents (HUB-PRODUCT.md): a persistent
 * side rail grouped by the operating cycle — Direction → Execution → Knowledge emphasized, with
 * the supporting domains quiet beneath. It reinforces the mental model continuously, not only
 * when navigating. requireTenant() here is for early-redirect UX; every read below re-runs it.
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

        <nav aria-label="Workspace" className="space-y-4">
          <RailLink href={base} exact>
            Dashboard
          </RailLink>

          <Domain label="Direction">
            <RailLink href={`${base}/objectives`}>Objectives</RailLink>
          </Domain>

          <Domain label="Execution">
            <RailLink href={`${base}/work`}>Work</RailLink>
            <RailLink href={`${base}/approvals`}>Approvals</RailLink>
          </Domain>

          <Domain label="Knowledge">
            <RailLink href={`${base}/knowledge`}>Knowledge</RailLink>
            <RailLink href={`${base}/decisions`}>Decisions</RailLink>
            <RailLink href={`${base}/documents`}>Documents</RailLink>
            <RailLink href={`${base}/artifacts`}>Artifacts</RailLink>
          </Domain>

          <div className="border-t border-[var(--border)] pt-4">
            {/* "Capability" is a provisional name — the "Resources" rename is still open. */}
            <Domain label="Capability">
              <RailLink href={`${base}/agents`} muted>
                Employees
              </RailLink>
              <RailLink href={`${base}/providers`} muted>
                Providers
              </RailLink>
            </Domain>
          </div>

          <Domain label="Governance">
            <RailLink href={`${base}/usage`} muted>
              Usage
            </RailLink>
            <RailLink href={`${base}/audit`} muted>
              Audit
            </RailLink>
            <RailLink href={`${base}/settings`} muted>
              Settings
            </RailLink>
          </Domain>
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl p-6">{children}</div>
      </main>
    </div>
  );
}

function Domain({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </p>
      {children}
    </div>
  );
}
