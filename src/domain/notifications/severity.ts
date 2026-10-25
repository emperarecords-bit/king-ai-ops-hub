import {
  type NotificationEventType,
  type NotificationSeverity,
  type NotificationRouting,
} from '@/types/domain';

/**
 * The single source of truth for how each event is treated. Pure + table-driven so routing is auditable and
 * unit-testable with no DB. Severity → routing policy (owner-approved):
 *   critical / action_required → immediate (email; bypasses quiet hours in the router)
 *   warning / informational    → digest (coalesced into a scheduled summary)
 *   success / routine          → in_app_only (visible in-app, never emailed by default)
 * A preference layer may later override routing per severity; this is the default every event starts from.
 */
export interface NotificationClassification {
  readonly severity: NotificationSeverity;
  readonly routing: NotificationRouting;
}

const CLASSIFICATION: Record<NotificationEventType, NotificationClassification> = {
  approval_pending: { severity: 'action_required', routing: 'immediate' },
  owner_question_raised: { severity: 'action_required', routing: 'immediate' },
  run_failed: { severity: 'critical', routing: 'immediate' },
  run_reconciliation_required: { severity: 'critical', routing: 'immediate' },
  run_completed: { severity: 'success', routing: 'in_app_only' },
};

/**
 * P5b-1 — a run the owner explicitly started from an Ops Chat card (runs.ops_chat_proposal_id set) is work they
 * are waiting on, so its COMPLETION is emailed (routing 'immediate') instead of staying in-app only. Severity stays
 * 'success': the router defers every non-critical immediate event in quiet hours, and 'success' + 'immediate' is
 * exactly this case (the owner's per-user opt-out in Settings applies to it). A linked FAILURE is already critical
 * + immediate and is unchanged. Unlinked runs are unchanged (in-app only).
 */
export const OPS_CHAT_RUN_COMPLETED: NotificationClassification = { severity: 'success', routing: 'immediate' };

export function classifyNotification(eventType: NotificationEventType, context: { readonly opsChatLinked?: boolean } = {}): NotificationClassification {
  if (eventType === 'run_completed' && context.opsChatLinked) return OPS_CHAT_RUN_COMPLETED;
  return CLASSIFICATION[eventType];
}

/** The Ops Chat run-completion email (see OPS_CHAT_RUN_COMPLETED) — the only success-severity event ever sent immediately. */
export function isOpsChatRunCompletion(e: { readonly severity: string; readonly routing?: string }): boolean {
  return e.severity === OPS_CHAT_RUN_COMPLETED.severity && (e.routing === undefined || e.routing === OPS_CHAT_RUN_COMPLETED.routing);
}

/** One incident → one key. UNIQUE(org, project, recipient, dedupeKey) makes capture idempotent. */
export function notificationDedupeKey(input: {
  readonly eventType: NotificationEventType;
  readonly entityType: string;
  readonly entityId: string;
}): string {
  return `${input.eventType}:${input.entityType}:${input.entityId}`;
}
