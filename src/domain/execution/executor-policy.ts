import { type ActionType } from '@/types/domain';
import { type ExecutorRiskClass } from './executor-contract';
import { hasEligibleExecutor } from './executors';

export const EXECUTOR_RISK_BY_ACTION: Readonly<Record<ActionType, ExecutorRiskClass>> = Object.freeze({
  file_write: 'reversible_internal_write', git_commit: 'external_reversible', git_push: 'external_reversible',
  git_pr: 'external_reversible', deployment: 'destructive_irreversible', db_mutation: 'destructive_irreversible',
  email_send: 'external_reversible', social_publish: 'external_reversible', financial: 'financial_regulated',
  destructive: 'destructive_irreversible', external_http: 'external_reversible',
  org_delegation: 'reversible_internal_write', supabase_deploy: 'external_reversible',
  // A single DML mutation against an arbitrary linked table is NOT provably reversible (triggers,
  // cascades, sequences, RLS, concurrency) — so its honest class is destructive_irreversible, which
  // the dispatch choke point blocks. v1 ships validation/dry-run only; there is no live executor.
  supabase_sql: 'destructive_irreversible',
});

export function executorFoundationStatus(actionType: ActionType) {
  return {
    riskClass: EXECUTOR_RISK_BY_ACTION[actionType],
    previewAvailable: actionType === 'file_write' || actionType === 'git_pr',
    /** True when a registered executor exists; the server still gates live dispatch via EXECUTORS_ENABLED. */
    liveEnabled: hasEligibleExecutor(actionType),
    confirmationRequired: true as const,
  };
}
