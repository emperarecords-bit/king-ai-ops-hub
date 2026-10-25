import {
  type NotificationEventType,
  type NotificationSeverity,
  type NotificationRouting,
  type NotificationChannelId,
  type NotificationMessageKind,
  type NotificationMessageStatus,
} from '@/types/domain';
import { type OpsChatRunLink } from './ops-chat-link';

export type {
  NotificationEventType,
  NotificationSeverity,
  NotificationRouting,
  NotificationChannelId,
  NotificationMessageKind,
  NotificationMessageStatus,
};

/**
 * What a lifecycle seam hands to `enqueueNotification`. The caller supplies the human-readable title/body and
 * the subject identity (entityType/entityId); severity, routing, and the dedupe key are DERIVED from eventType
 * so callers can never disagree about how an event should be treated.
 */
export interface NotificationInput {
  readonly eventType: NotificationEventType;
  /** The subject the event is about: 'approval' | 'owner_question' | 'run'. Provenance, not an FK. */
  readonly entityType: string;
  readonly entityId: string;
  readonly title: string;
  readonly body: string;
  /**
   * P5b-1: set ONLY for a run started from an Ops Chat card (runs.ops_chat_proposal_id). Makes a completion
   * immediate (emailed) and appends a link — to the card when the recipient owns it, else to the task.
   */
  readonly opsChat?: OpsChatRunLink;
}
