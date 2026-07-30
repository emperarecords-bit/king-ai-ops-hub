import { formatMicrosExact } from '@/domain/reporting/format-money';

/**
 * M0a reporting presentation — NUMERIC / IDENTIFIER ONLY. These components render counts, tokens, costs,
 * statuses, ids, and approved display labels. They never accept or render task input, prompts, responses,
 * results, review detail, error text, or evidence (M0a §9).
 *
 * Money is formatted by `formatMicrosExact` (exact bigint → decimal string). NO monetary micros value is ever
 * converted to a JS `number` here or downstream.
 */

export function money(m: bigint): string {
  return formatMicrosExact(m);
}

/**
 * Basis points (0..10000) → "xx.x%"; null → "n/a". `bpsValue` is a BOUNDED coverage ratio (≤10000), never a
 * monetary value — this integer division does not touch micros.
 */
export function pct(bpsValue: number | null): string {
  if (bpsValue == null) return 'n/a';
  const whole = Math.trunc(bpsValue / 100);
  const frac = Math.abs(bpsValue % 100);
  return `${whole}.${Math.trunc(frac / 10)}%`;
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-xs text-neutral-500">{sub}</p> : null}
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  empty = 'No rows in the selected window.',
}: {
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-neutral-500">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
            {columns.map((c) => (
              <th key={c} className="py-2 pr-4 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-neutral-100 dark:border-neutral-800/60">
              {r.map((cell, j) => (
                <td key={j} className="py-2 pr-4 tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
      {children}
    </p>
  );
}
