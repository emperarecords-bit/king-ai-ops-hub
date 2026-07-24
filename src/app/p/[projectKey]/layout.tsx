import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { AppError } from '@/lib/errors';
import { NavLink } from '@/components/ui';

/**
 * Workspace shell. The requireTenant() call here is for early redirect UX;
 * every server action and data read below re-runs it — the layout is never
 * the security boundary.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;

  try {
    await requireTenant(projectKey);
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthenticated') redirect('/login');
    redirect('/projects');
  }

  const base = `/p/${projectKey}`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-2">
          <Link href="/projects" className="mr-3 text-sm font-bold text-[var(--accent)]">
            ⬡ {projectKey}
          </Link>
          <NavLink href={base}>Dashboard</NavLink>
          <NavLink href={`${base}/objectives`}>Objectives</NavLink>
          <NavLink href={`${base}/tasks/new`}>New task</NavLink>
          <NavLink href={`${base}/approvals`}>Approvals</NavLink>
          <NavLink href={`${base}/artifacts`}>Artifacts</NavLink>
          <NavLink href={`${base}/agents`}>Agents</NavLink>
          <NavLink href={`${base}/providers`}>Providers</NavLink>
          <NavLink href={`${base}/usage`}>Usage</NavLink>
          <NavLink href={`${base}/audit`}>Audit</NavLink>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
