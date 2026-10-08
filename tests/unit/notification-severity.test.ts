import { describe, expect, it } from 'vitest';
import { classifyNotification, notificationDedupeKey } from '@/domain/notifications/severity';
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '@/types/domain';

/**
 * Pure routing policy — the one place that decides how each event is treated. No DB. These assertions are the
 * owner-approved contract: critical/action_required interrupt (immediate), success stays in-app, and every event
 * type has an explicit mapping (a new event type without one fails the exhaustiveness check below).
 */
describe('classifyNotification — severity + routing policy', () => {
  it('maps the attention events to immediate and completions to in-app', () => {
    expect(classifyNotification('approval_pending')).toEqual({ severity: 'action_required', routing: 'immediate' });
    expect(classifyNotification('owner_question_raised')).toEqual({ severity: 'action_required', routing: 'immediate' });
    expect(classifyNotification('run_failed')).toEqual({ severity: 'critical', routing: 'immediate' });
    expect(classifyNotification('run_reconciliation_required')).toEqual({ severity: 'critical', routing: 'immediate' });
    expect(classifyNotification('run_completed')).toEqual({ severity: 'success', routing: 'in_app_only' });
  });

  it('classifies every declared event type (no gaps)', () => {
    for (const t of NOTIFICATION_EVENT_TYPES as readonly NotificationEventType[]) {
      const c = classifyNotification(t);
      expect(['critical', 'action_required', 'warning', 'informational', 'success']).toContain(c.severity);
      expect(['immediate', 'digest', 'in_app_only']).toContain(c.routing);
    }
  });

  it('critical/action_required never routes to in_app_only (the attention set must be deliverable)', () => {
    for (const t of NOTIFICATION_EVENT_TYPES as readonly NotificationEventType[]) {
      const c = classifyNotification(t);
      if (c.severity === 'critical' || c.severity === 'action_required') {
        expect(c.routing).toBe('immediate');
      }
    }
  });
});

describe('notificationDedupeKey — one incident, one key', () => {
  it('is stable and entity-scoped', () => {
    expect(notificationDedupeKey({ eventType: 'run_failed', entityType: 'run', entityId: 'r1' })).toBe('run_failed:run:r1');
    expect(notificationDedupeKey({ eventType: 'approval_pending', entityType: 'approval', entityId: 'a9' })).toBe(
      'approval_pending:approval:a9',
    );
  });

  it('distinguishes different events on the same entity', () => {
    const a = notificationDedupeKey({ eventType: 'run_failed', entityType: 'run', entityId: 'r1' });
    const b = notificationDedupeKey({ eventType: 'run_completed', entityType: 'run', entityId: 'r1' });
    expect(a).not.toBe(b);
  });
});
