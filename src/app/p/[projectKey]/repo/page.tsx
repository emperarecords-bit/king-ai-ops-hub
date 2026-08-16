import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getGitHubClient, GitHubUnconfiguredError, type RepoTreeEntry } from '@/domain/github/client';
import { listRepoLinks } from '@/domain/github/links';
import { listContextItems } from '@/domain/github/content';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { ContextStatusButton } from './import-button';

/**
 * The Repository browser: read the workspace's linked repo and hand chosen files to the employees.
 * Reading is free; a file reaches the AI staff ONLY through the import-and-approve gate (context
 * items), and repo content stays untrusted reference material at prompt time.
 */
export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(projectKey);
  const { links, items } = await withTenant(ctx, async (tx) => ({
    links: await listRepoLinks(tx, ctx),
    items: await listContextItems(tx, ctx),
  }));

  if (links.length === 0) {
    return (
      <div>
        <PageHeader title="Repository" subtitle="No repository is linked to this workspace yet." />
        <EmptyState>Link a GitHub repository to browse its files here and share them with your employees.</EmptyState>
      </div>
    );
  }

  const requested = typeof sp.r === 'string' ? sp.r : null;
  const link = links.find((l) => l.repoFullName === requested) ?? links[0]!;

  let tree: RepoTreeEntry[] = [];
  let treeError: string | null = null;
  try {
    tree = await getGitHubClient().listTree({ installationId: link.installationId, repoFullName: link.repoFullName }, link.defaultBranch);
  } catch (err) {
    treeError =
      err instanceof GitHubUnconfiguredError
        ? 'GitHub access is not configured in this environment.'
        : 'Could not read the repository tree from GitHub.';
  }

  const sharedTitles = new Set(items.filter((i) => i.status === 'approved').map((i) => i.title));
  const blobs = tree.filter((e) => e.type === 'blob');
  const byDir = new Map<string, RepoTreeEntry[]>();
  for (const b of blobs) {
    const top = b.path.includes('/') ? b.path.slice(0, b.path.indexOf('/')) : '(root)';
    const arr = byDir.get(top) ?? [];
    arr.push(b);
    byDir.set(top, arr);
  }
  const dirs = [...byDir.keys()].sort((a, b) => (a === '(root)' ? -1 : b === '(root)' ? 1 : a.localeCompare(b)));

  return (
    <div>
      <PageHeader
        title="Repository"
        subtitle={`${link.repoFullName} @ ${link.defaultBranch} — read any file, then share it so your employees can read it too.`}
      />

      {links.length > 1 ? (
        <p className="mb-4 text-sm text-[var(--muted)]">
          Linked repositories:{' '}
          {links.map((l, i) => (
            <span key={l.id}>
              {i > 0 ? ' · ' : ''}
              {l.repoFullName === link.repoFullName ? (
                <span className="font-semibold text-[var(--foreground)]">{l.repoFullName}</span>
              ) : (
                <Link href={`/p/${projectKey}/repo?r=${encodeURIComponent(l.repoFullName)}`} className="text-[var(--accent)]">
                  {l.repoFullName}
                </Link>
              )}
            </span>
          ))}
        </p>
      ) : null}

      {items.length > 0 ? (
        <Card title={`Shared with employees (${items.filter((i) => i.status === 'approved').length} live)`} className="mb-6">
          <ul className="divide-y divide-[var(--border)] text-sm">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{i.title}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    i.status === 'approved'
                      ? 'bg-[var(--surface-raised)] text-[var(--success)]'
                      : i.status === 'pending'
                        ? 'bg-[var(--surface-raised)] text-[#e5c07b]'
                        : 'bg-[var(--surface-raised)] text-[var(--muted)]'
                  }`}
                >
                  {i.status}
                </span>
                <span className="text-xs text-[var(--muted)]">{(i.bytes / 1024).toFixed(1)} KB</span>
                {i.status === 'pending' && ctx.projectRole === 'admin' ? (
                  <ContextStatusButton projectKey={projectKey} itemId={i.id} op="approve" />
                ) : null}
                {i.status !== 'archived' && ctx.projectRole === 'admin' ? (
                  <ContextStatusButton projectKey={projectKey} itemId={i.id} op="archive" />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {treeError ? (
        <Card title="Repository tree" className="mb-6">
          <p className="text-sm text-[var(--danger)]">{treeError}</p>
        </Card>
      ) : (
        <Card title={`Files (${blobs.length})`} className="mb-6">
          <div className="space-y-1">
            {dirs.map((dir) => {
              const entries = byDir.get(dir)!;
              return (
                <details key={dir} className="rounded border border-[var(--border)]">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-[var(--surface-raised)]">
                    {dir}/ <span className="text-xs text-[var(--muted)]">({entries.length})</span>
                  </summary>
                  <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                    {entries.map((e) => (
                      <li key={e.path} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                        <Link
                          href={`/p/${projectKey}/repo/file?r=${encodeURIComponent(link.repoFullName)}&path=${encodeURIComponent(e.path)}`}
                          className="min-w-0 flex-1 truncate font-mono text-xs hover:text-[var(--accent)]"
                        >
                          {e.path}
                        </Link>
                        {sharedTitles.has(`github:${link.repoFullName}@${link.defaultBranch}:${e.path}`) ? (
                          <span className="rounded bg-[var(--surface-raised)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--success)]">
                            shared
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs text-[var(--muted)]">{e.size != null ? `${(e.size / 1024).toFixed(1)} KB` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
