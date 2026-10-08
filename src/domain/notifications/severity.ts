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

export function classifyNotification(eventType: NotificationEventType): NotificationClassification {
  return CLASSIFICATION[eventType];
}

/** One incident → one key. UNIQUE(org, project, recipient, dedupeKey) makes capture idempotent. */
export function notificationDedupeKey(input: {
  readonly eventType: NotificationEventType;
  readonly entityType: string;
  readonly entityId: string;
}): string {
  return `${input.eventType}:${input.entityType}:${input.entityId}`;
}
