import { type ActionType } from '@/types/domain';
import { executorFoundationStatus } from '@/domain/execution/executor-policy';

const RISK_LABEL = { read_only: 'Read-only', reversible_internal_write: 'Reversible internal write', external_reversible: 'External reversible action', financial_regulated: 'Financial or regulated action', destructive_irreversible: 'Destructive or irreversible action' } as const;

/** Status/preview boundary only. Deliberately contains no form, action, button, or dispatch import. */
export function ExecutorFoundationStatus({ actionType }: { actionType: ActionType }) {
  const status = executorFoundationStatus(actionType);
  return <div data-executor-status="preview-only" className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm">
    <dl className="grid gap-2 sm:grid-cols-2">
      <div><dt className="text-xs text-[var(--muted)]">Risk classification</dt><dd>{RISK_LABEL[status.riskClass]}</dd></div>
      <div><dt className="text-xs text-[var(--muted)]">Execution mode</dt><dd>{status.liveEnabled ? 'Live — executes on your authorization (server-gated)' : 'Disabled — dry-run foundation only'}</dd></div>
      <div><dt className="text-xs text-[var(--muted)]">Confirmation</dt><dd>Required and payload-bound</dd></div>
      <div><dt className="text-xs text-[var(--muted)]">Preview support</dt><dd>{status.previewAvailable ? 'Contract available; no side effect' : 'Not available for this action class'}</dd></div>
    </dl>
    <p className="mt-3 text-xs text-[var(--muted)]">{status.liveEnabled ? 'A live executor is registered for this action type. Authorizing dispatches it through the policy-gated choke point (payload re-verification, branch + PR-only write policy, kill switch).' : 'No live executor capability is enabled for this action type. Authorization does not dispatch it.'}</p>
  </div>;
}
