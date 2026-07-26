'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * A destination in the workspace rail. The rail is the workspace's table of contents
 * (HUB-PRODUCT.md) — grouped by the operating cycle, with fixed emphasis. This component owns
 * only one thing the server layout can't: "you are here." Cycle destinations read at full
 * strength; supporting domains (muted) read quieter — a permanent, non-adaptive hierarchy.
 */
export function RailLink({
  href,
  children,
  exact = false,
  muted = false,
}: {
  href: string;
  children: React.ReactNode;
  /** Match the path exactly (the Dashboard/lobby), else treat href as a section root. */
  exact?: boolean;
  /** Supporting domains render quieter than the cycle. */
  muted?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  const cls = active
    ? 'bg-[var(--surface-raised)] font-medium text-[var(--accent)]'
    : muted
      ? 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--foreground)]'
      : 'text-[var(--foreground)] hover:bg-[var(--surface-raised)]';

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-md py-1.5 pl-6 pr-2 text-sm transition-colors ${cls}`}
    >
      {children}
    </Link>
  );
}
