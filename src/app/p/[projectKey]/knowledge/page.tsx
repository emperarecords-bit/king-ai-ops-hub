import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listKnowledge } from '@/domain/knowledge/knowledge';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { KnowledgeStatusButtons, NewKnowledgeForm, ReviseKnowledgeForm } from './knowledge-forms';

const KIND_LABEL: Record<string, string> = {
  fact: 'Facts',
  standard: 'Standards',
  policy: 'Policies',
  decision: 'Decisions',
  playbook: 'Playbooks',
  persona: 'Customer personas',
  template: 'Templates',
  brand: 'Brand',
};

/**
 * Company Knowledge (K1): what your team knows. Active items are consulted by
 * every employee before every piece of work in this workspace; drafts are
 * quarantined; versions supersede, never overwrite.
 */
export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const items = await withTenant(ctx, (tx) => listKnowledge(tx, ctx));

  const active = items.filter((i) => i.status === 'active');
  const drafts = items.filter((i) => i.status === 'draft');
  const archived = items.filter((i) => i.status === 'archived');

  const activeByKind = new Map<string, typeof active>();
  for (const item of active) {
    if (!activeByKind.has(item.kind)) activeByKind.set(item.kind, []);
    activeByKind.get(item.kind)!.push(item);
  }

  return (
    <div>
      <PageHeader
        title="Knowledge"
        subtitle="What your team knows. Every active item is consulted by every employee before beginning work in this workspace — and only this workspace."
      />

      <Card title="Add knowledge" className="mb-6">
        <NewKnowledgeForm projectKey={projectKey} />
      </Card>

      {drafts.length > 0 ? (
        <Card title={`Drafts awaiting your approval (${drafts.length})`} className="mb-6 border-[var(--accent)]">
          <ul className="space-y-3">
            {drafts.map((item) => (
              <li key={item.id} className="rounded-md border border-[var(--border)] p-3">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">
                    {item.title}
                    {item.version > 1 ? (
                      <span className="ml-2 text-xs text-[var(--muted)]">v{item.version}</span>
                    ) : null}
                  </span>
                  <KnowledgeStatusButtons projectKey={projectKey} itemId={item.id} status={item.status} />
                </div>
                <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">{item.body}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {active.length === 0 && drafts.length === 0 ? (
        <EmptyState>
          Nothing here yet. Add what your team should always know — standards, decisions,
          personas, playbooks — and every future piece of work starts from it.
        </EmptyState>
      ) : (
        [...activeByKind.entries()].map(([kind, kindItems]) => (
          <Card key={kind} title={`${KIND_LABEL[kind] ?? kind} (${kindItems.length})`} className="mb-6">
            <ul className="space-y-3">
              {kindItems.map((item) => (
                <li key={item.id} className="rounded-md border border-[var(--border)] p-3">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {item.title}
                      <span className="ml-2 text-xs text-[var(--muted)]">v{item.version}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <ReviseKnowledgeForm
                        projectKey={projectKey}
                        itemId={item.id}
                        currentBody={item.body}
                      />
                      <KnowledgeStatusButtons
                        projectKey={projectKey}
                        itemId={item.id}
                        status={item.status}
                      />
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">{item.body}</p>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      {archived.length > 0 ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
            Version history &amp; retired items ({archived.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {archived.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3 text-sm text-[var(--muted)]"
              >
                <span>
                  {item.title} <span className="text-xs">v{item.version}</span>
                </span>
                <StatusBadge status={item.status} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
