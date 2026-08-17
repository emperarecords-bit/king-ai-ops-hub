import { requireTenant } from '@/domain/auth/guard';
import { getObjectStore } from '@/domain/documents/object-store';
import { listWorkspaceMedia } from '@/domain/media/media';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { MediaUploadForm } from './upload-form';

/**
 * The Screening Room (owner directive 2026-08-17): every cut, still, and track this business
 * produces, playable right here — phone included. Media is for HUMAN eyes; it never enters AI
 * run context (that is what Documents are for).
 */
export default async function ScreeningRoomPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const canUpload = ctx.projectRole === 'admin';
  const store = await getObjectStore();
  const items = await listWorkspaceMedia(store, ctx);
  const mb = (n: number | null): string => (n == null ? '' : `${(n / 1_000_000).toFixed(1)} MB`);
  const src = (name: string): string => `/api/media/${projectKey}/${encodeURIComponent(name)}`;

  const videos = items.filter((i) => i.kind === 'video');
  const images = items.filter((i) => i.kind === 'image');
  const audio = items.filter((i) => i.kind === 'audio');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Screening Room"
        subtitle="Watch what this business has produced — cuts, stills, and audio, playable right here."
      />

      {canUpload ? (
        <Card className="mb-6">
          <MediaUploadForm projectKey={projectKey} />
        </Card>
      ) : null}

      {items.length === 0 ? (
        <EmptyState>
          Nothing on the shelf yet. Upload a video, image, or audio file and it plays right here —
          on your phone too.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {videos.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
                Videos · {videos.length}
              </h2>
              <div className="space-y-6">
                {videos.map((v) => (
                  <Card key={v.name}>
                    <p className="mb-2 text-sm font-semibold">
                      {v.name} <span className="font-normal text-[var(--muted)]">· {mb(v.sizeBytes)}</span>
                    </p>
                    { }
                    <video controls preload="metadata" playsInline className="w-full rounded" src={src(v.name)} />
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {images.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
                Stills · {images.length}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {images.map((i) => (
                  <a key={i.name} href={src(i.name)} target="_blank" rel="noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- object-store route, not a static asset */}
                    <img src={src(i.name)} alt={i.name} className="w-full rounded border border-[var(--border)]" />
                    <p className="mt-1 truncate text-xs text-[var(--muted)]">{i.name}</p>
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          {audio.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
                Audio · {audio.length}
              </h2>
              <div className="space-y-3">
                {audio.map((a) => (
                  <Card key={a.name}>
                    <p className="mb-2 text-sm">{a.name}</p>
                    { }
                    <audio controls preload="metadata" className="w-full" src={src(a.name)} />
                  </Card>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
