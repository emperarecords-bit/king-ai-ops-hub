'use client';

import { usePathname } from 'next/navigation';
import { resolveLocation } from './nav-model';

/**
 * The precise-location signal. Structure (Domain › Section) comes from the shared nav model; the
 * dynamic final label — the actual record you're looking at — is supplied by the page from its
 * loaded entity (never a raw id or route param, which would leak plumbing). Rail = which room;
 * breadcrumb = what exactly you're looking at inside it. Renders nothing in the lobby.
 */
export function Breadcrumb({ leaf }: { leaf?: string }) {
  const pathname = usePathname();
  const base = pathname.split('/').slice(0, 3).join('/'); // /p/<key>
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const loc = resolveLocation(sub);

  if (loc.isLobby || !loc.domainLabel) return null;

  const sep = (
    <span aria-hidden="true" className="opacity-60">
      {' › '}
    </span>
  );

  return (
    <p className="mb-4 text-xs text-[var(--muted)]">
      {loc.domainLabel}
      {loc.sectionLabel ? (
        <>
          {sep}
          {loc.sectionLabel}
        </>
      ) : null}
      {leaf ? (
        <>
          {sep}
          <span className="text-[var(--foreground)]">{leaf}</span>
        </>
      ) : null}
    </p>
  );
}
