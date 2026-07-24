import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAgents } from '@/domain/agents/agents';
import { modelsForProvider } from '@/providers/pricing';
import { type ProviderId } from '@/types/provider';
import { Card, PageHeader, ProviderBadge } from '@/components/ui';
import { AgentForm } from './agent-form';

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const agents = await withTenant(ctx, (tx) => listAgents(tx, ctx));

  return (
    <div>
      <PageHeader
        title="Agent settings"
        subtitle="Per-project agent configuration. The engine picks the enabled agent matching each run's (role, provider); system prompts are always wrapped with the platform safety rules."
      />
      <div className="space-y-6">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <div className="mb-3 flex items-center gap-3">
              <h3 className="font-semibold">{agent.name}</h3>
              <ProviderBadge provider={agent.provider} />
              <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs capitalize text-[var(--muted)]">
                {agent.role}
              </span>
              {!agent.enabled ? (
                <span className="text-xs text-[var(--danger)]">disabled</span>
              ) : null}
            </div>
            <AgentForm
              projectKey={projectKey}
              agent={agent}
              models={modelsForProvider(agent.provider as ProviderId)}
            />
          </Card>
        ))}
      </div>
    </div>
  );
}
