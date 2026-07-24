import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listSecrets } from '@/domain/integrations/secrets';
import { MODEL_PRICING } from '@/providers/pricing';
import { formatMoney } from '@/lib/money';
import { Card, EmptyState, PageHeader, ProviderBadge } from '@/components/ui';
import { AddSecretForm, DeleteSecretButton } from './secret-forms';

export default async function ProviderSettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const secrets = await withTenant(ctx, (tx) => listSecrets(tx, ctx));

  return (
    <div>
      <PageHeader
        title="Provider settings"
        subtitle="Platform model keys live in server environment variables and never touch the browser or the database. Project-scoped integration secrets below are AES-256-GCM encrypted at rest."
      />

      <Card title="Available models & pricing" className="mb-6">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
              <th className="py-2 pr-4">Model</th>
              <th className="py-2 pr-4">Provider</th>
              <th className="py-2 pr-4">Input / M tokens</th>
              <th className="py-2">Output / M tokens</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MODEL_PRICING).map(([id, p]) => (
              <tr key={id} className="border-b border-[var(--border)]">
                <td className="py-2 pr-4 font-mono text-xs">{id}</td>
                <td className="py-2 pr-4">
                  <ProviderBadge provider={p.provider} />
                </td>
                <td className="py-2 pr-4">{formatMoney({ usdMicros: p.inputMicrosPerM })}</td>
                <td className="py-2">{formatMoney({ usdMicros: p.outputMicrosPerM })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Project integration secrets">
        <div className="mb-4">
          <AddSecretForm projectKey={projectKey} />
        </div>
        {secrets.length === 0 ? (
          <EmptyState>No integration secrets stored for this project.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Value</th>
                <th className="py-2 pr-4">Key version</th>
                <th className="py-2 pr-4">Updated</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.id} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-4 font-mono text-xs">{s.name}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-[var(--muted)]">
                    ••••{s.lastFour}
                  </td>
                  <td className="py-2 pr-4 text-[var(--muted)]">v{s.keyVersion}</td>
                  <td className="py-2 pr-4 text-[var(--muted)]">
                    {s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="py-2">
                    <DeleteSecretButton projectKey={projectKey} secretId={s.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
