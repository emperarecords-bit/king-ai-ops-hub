'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_DOMAINS, resolveLocation } from './nav-model';

/**
 * The workspace rail — the table of contents for the workspace. Grouped by the operating cycle
 * with fixed emphasis (cycle bright, supporting domains quiet). Active state is domain-aware:
 * a route highlights its parent domain even when it isn't a rail destination (e.g. a task page
 * lights Execution), so the first navigation responsibility — "which part am I in?" — always
 * has an answer.
 */
export function WorkspaceNav({ base }: { base: string }) {
  const pathname = usePathname();
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const loc = resolveLocation(sub);

  const itemCls = (active: boolean, primary: boolean) =>
    active
      ? 'bg-[var(--surface-raised)] font-medium text-[var(--accent)]'
      : primary
        ? 'text-[var(--foreground)] hover:bg-[var(--surface-raised)]'
        : 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--foreground)]';

  return (
    <nav aria-label="Workspace" className="space-y-4">
      <Link
        href={base}
        aria-current={loc.isLobby ? 'page' : undefined}
        className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
          loc.isLobby
            ? 'bg-[var(--surface-raised)] font-medium text-[var(--accent)]'
            : 'text-[var(--foreground)] hover:bg-[var(--surface-raised)]'
        }`}
      >
        Dashboard
      </Link>

      {NAV_DOMAINS.map((d, i) => {
        const startsSupport = !d.primary && (i === 0 || NAV_DOMAINS[i - 1]!.primary);
        return (
          <div key={d.key} className={startsSupport ? 'space-y-0.5 border-t border-[var(--border)] pt-4' : 'space-y-0.5'}>
            <p
              className={`px-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide ${
                loc.domainKey === d.key ? 'text-[var(--foreground)]' : 'text-[var(--muted)]'
              }`}
            >
              {d.label}
            </p>
            {d.items.map((it) => {
              const active = loc.itemSlug === it.slug;
              return (
                <Link
                  key={it.slug}
                  href={`${base}/${it.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={`block rounded-md py-1.5 pl-6 pr-2 text-sm transition-colors ${itemCls(active, d.primary)}`}
                >
                  {it.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
