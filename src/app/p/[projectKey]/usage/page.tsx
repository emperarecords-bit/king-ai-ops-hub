import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  currentPeriodStart,
  projectSpendLimit,
  spentThisPeriodMicros,
  usageSummary,
} from '@/domain/usage/usage';
import { formatMoney } from '@/lib/money';
import { Card, EmptyState, PageHeader, ProviderBadge } from '@/components/ui';

export default async function UsagePage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { summary, spent, limit } = await withTenant(ctx, async (tx) => ({
    summary: await usageSummary(tx, ctx.projectId),
    spent: await spentThisPeriodMicros(tx, ctx.projectId),
    limit: await projectSpendLimit(tx, ctx.projectId),
  }));

  const period = currentPeriodStart().toISOString().slice(0, 7);

  return (
    <div>
      <PageHeader
        title="Usage & cost"
        subtitle={`Current period: ${period} (UTC calendar month). Costs are exact integer micros computed against the versioned pricing table at the moment of use.`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card title="Spent this period">
          <p className="text-3xl font-bold">{formatMoney({ usdMicros: spent })}</p>
        </Card>
        <Card title="Monthly limit">
          <p className="text-3xl font-bold">{formatMoney({ usdMicros: limit })}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Runs are refused before the first token once the limit is reached.
          </p>
        </Card>
      </div>

      <Card title="By provider and model">
        {summary.length === 0 ? (
          <EmptyState>No usage recorded this period.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Model</th>
                <th className="py-2 pr-4">Calls</th>
                <th className="py-2 pr-4">Input tokens</th>
                <th className="py-2 pr-4">Output tokens</th>
                <th className="py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={`${row.provider}-${row.model}`} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-4">
                    <ProviderBadge provider={row.provider} />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{row.model}</td>
                  <td className="py-2 pr-4">{row.events}</td>
                  <td className="py-2 pr-4">{row.inputTokens.toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.outputTokens.toLocaleString()}</td>
                  <td className="py-2 font-medium">{formatMoney({ usdMicros: row.costMicros })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
