import { type ActionType } from '@/types/domain';
import { type ExecutorRiskClass } from './executor-contract';

export const EXECUTOR_RISK_BY_ACTION: Readonly<Record<ActionType, ExecutorRiskClass>> = Object.freeze({
  file_write: 'reversible_internal_write', git_commit: 'external_reversible', git_push: 'external_reversible',
  git_pr: 'external_reversible', deployment: 'destructive_irreversible', db_mutation: 'destructive_irreversible',
  email_send: 'external_reversible', social_publish: 'external_reversible', financial: 'financial_regulated',
  destructive: 'destructive_irreversible', external_http: 'external_reversible',
});

export function executorFoundationStatus(actionType: ActionType) {
  return { riskClass: EXECUTOR_RISK_BY_ACTION[actionType], previewAvailable: actionType === 'file_write', liveEnabled: false as const, confirmationRequired: true as const };
}
