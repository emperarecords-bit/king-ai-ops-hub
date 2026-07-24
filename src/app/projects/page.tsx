import Link from 'next/link';
import { listMyProjects, requireUser } from '@/domain/auth/guard';
import { signOut } from '@/app/login/actions';
import { EmptyState } from '@/components/ui';

export default async function ProjectSelectorPage() {
  const user = await requireUser();
  const projects = await listMyProjects();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Select a workspace</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Signed in as {user.email}. Each workspace is fully isolated — context, memory, tasks,
            and secrets never cross.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/projects/new"
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            + New workspace
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {projects.length === 0 ? (
        <EmptyState>
          Welcome! Create your first workspace — it arrives already staffed with an AI team, a
          budget, and its own isolated memory.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.projectId}>
              <Link
                href={`/p/${p.key}`}
                className="block rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--accent)]"
              >
                <h2 className="font-semibold">{p.name}</h2>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{p.description}</p>
                <p className="mt-3 text-xs uppercase tracking-wide text-[var(--muted)]">
                  {p.projectRole}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
