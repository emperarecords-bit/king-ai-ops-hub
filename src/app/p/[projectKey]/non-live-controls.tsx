import Link from 'next/link';
import { type DataClassification } from '@/types/domain';
import { type ExclusionSummary, classificationLabel, exclusionNote, visibilityToggleHref } from '@/domain/classification/classification';

/**
 * HUB-009 — the shared, page-scoped "Show demo/seed data" control + discoverable exclusion note. Default is
 * live-only; toggling sets `?includeNonLive=1` (preserving every other query parameter); hiding removes only
 * that parameter. No hidden/persisted preference — the URL is the whole state. Never bypasses authorization;
 * it only reveals records the viewer already has tenant/role access to.
 */
export function NonLiveControls({
  pathname,
  searchParams,
  includeNonLive,
  excluded,
}: {
  pathname: string;
  searchParams: Record<string, string | string[] | undefined>;
  includeNonLive: boolean;
  excluded?: ExclusionSummary;
}) {
  const note = !includeNonLive && excluded ? exclusionNote(excluded) : null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]" data-testid="non-live-controls">
      {note ? <span data-testid="exclusion-note">{note}</span> : null}
      {includeNonLive ? (
        <>
          <span className="text-[var(--accent)]">Showing demo/seed data</span>
          <Link href={visibilityToggleHref(pathname, searchParams, false)} className="underline">Hide demo/seed data</Link>
        </>
      ) : (
        <Link href={visibilityToggleHref(pathname, searchParams, true)} className="underline">Show demo/seed data</Link>
      )}
    </div>
  );
}

/** A small inline classification chip (`Demo`/`Seed`) for a non-live row; renders nothing for a live row. */
export function ClassificationChip({ classification }: { classification: DataClassification }) {
  const label = classificationLabel(classification);
  if (!label) return null;
  return (
    <span
      data-testid={`class-chip-${classification}`}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${classification === 'demo' ? 'bg-[#6b5a3d] text-[#f0e2c8]' : 'bg-[#3d5a6b] text-[#c8e2f0]'}`}
    >
      {label}
    </span>
  );
}
