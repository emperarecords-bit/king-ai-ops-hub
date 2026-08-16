import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getGitHubClient, GitHubUnconfiguredError } from '@/domain/github/client';
import { listRepoLinks } from '@/domain/github/links';
import { Card, PageHeader } from '@/components/ui';
import { ImportFileButton } from '../import-button';

const BINARY_EXTENSIONS = new Set([
  'blend', 'blend1', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'exr', 'mp4', 'mov', 'wav', 'mp3', 'ogg',
  'zip', 'gz', 'tar', '7z', 'exe', 'dll', 'pyc', 'pyd', 'so', 'pdf', 'ico', 'ttf', 'woff', 'woff2',
]);
const MAX_DISPLAY_CHARS = 100_000;

/** Read one repo file. Content is DATA: rendered as escaped text, never executed or interpreted. */
export default async function RepoFilePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const path = typeof sp.path === 'string' ? sp.path : '';
  const requested = typeof sp.r === 'string' ? sp.r : null;
  const ctx = await requireTenant(projectKey);
  const links = await withTenant(ctx, (tx) => listRepoLinks(tx, ctx));
  const link = links.find((l) => l.repoFullName === requested) ?? links[0];

  const back = (
    <Link href={`/p/${projectKey}/repo`} className="text-sm text-[var(--accent)]">
      ← Back to repository
    </Link>
  );

  if (!link || !path) {
    return (
      <div>
        <PageHeader title="Repository file" subtitle="Nothing to show." />
        {back}
      </div>
    );
  }

  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const isBinary = BINARY_EXTENSIONS.has(ext);

  let content: string | null = null;
  let error: string | null = null;
  if (!isBinary) {
    try {
      content = await getGitHubClient().readBlob(
        { installationId: link.installationId, repoFullName: link.repoFullName },
        link.defaultBranch,
        path,
      );
    } catch (err) {
      error =
        err instanceof GitHubUnconfiguredError
          ? 'GitHub access is not configured in this environment.'
          : 'Could not read this file from GitHub.';
    }
  }

  return (
    <div>
      <PageHeader title={path} subtitle={`${link.repoFullName} @ ${link.defaultBranch}`} />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        {back}
        {!isBinary && content != null ? (
          <ImportFileButton projectKey={projectKey} repoFullName={link.repoFullName} path={path} />
        ) : null}
      </div>

      {isBinary ? (
        <Card title="Binary file">
          <p className="text-sm text-[var(--muted)]">
            This is a binary file (.{ext}) — it cannot be displayed or shared as readable context. Employees work with
            binary assets through manifests, records, and build plans instead.
          </p>
        </Card>
      ) : error ? (
        <Card title="Error">
          <p className="text-sm text-[var(--danger)]">{error}</p>
        </Card>
      ) : (
        <Card title={`Content${content!.length > MAX_DISPLAY_CHARS ? ' (first 100k characters)' : ''}`}>
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 text-xs leading-relaxed">
            {content!.slice(0, MAX_DISPLAY_CHARS)}
          </pre>
        </Card>
      )}
    </div>
  );
}
