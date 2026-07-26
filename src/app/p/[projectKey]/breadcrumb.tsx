'use client';

import { usePathname } from 'next/navigation';
import { resolveLocation } from './nav-model';

/**
 * The precise-location signal, derived from the same nav model as the rail. Shows "Domain ›
 * Section" so a detail page still names where it lives in the operating model (e.g. a task page
 * reads "Execution › AI work"). Renders nothing in the lobby (Dashboard) or for unmapped routes.
 */
export function Breadcrumb({ base }: { base: string }) {
  const pathname = usePathname();
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const loc = resolveLocation(sub);

  if (loc.isLobby || !loc.domainLabel) return null;

  return (
    <p className="mb-4 text-xs text-[var(--muted)]">
      {loc.domainLabel}
      {loc.sectionLabel ? (
        <>
          {' '}
          <span aria-hidden="true" className="opacity-60">
            ›
          </span>{' '}
          {loc.sectionLabel}
        </>
      ) : null}
    </p>
  );
}
