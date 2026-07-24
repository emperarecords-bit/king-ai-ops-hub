import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTION_TYPES,
  AGENT_ROLES,
  APPROVAL_STATUSES,
  ARTIFACT_KINDS,
  CONTEXT_ITEM_STATUSES,
  MESSAGE_ROLES,
  ORG_ROLES,
  PROJECT_ROLES,
  REVIEW_VERDICTS,
  RUN_STATUSES,
  STEP_KINDS,
  TASK_STATUSES,
} from '@/types/domain';
import { PROVIDER_IDS, PROVIDER_SELECTIONS } from '@/types/provider';

/**
 * Postgres enums mirror the TypeScript unions in src/types/domain.ts so the
 * database rejects values the application layer forgot to. The TS constants are
 * the source of truth; these just project them into DDL.
 */

export const providerIdEnum = pgEnum('provider_id', PROVIDER_IDS);
export const providerSelectionEnum = pgEnum('provider_selection', PROVIDER_SELECTIONS);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);
export const stepKindEnum = pgEnum('step_kind', STEP_KINDS);
export const messageRoleEnum = pgEnum('message_role', MESSAGE_ROLES);
export const reviewVerdictEnum = pgEnum('review_verdict', REVIEW_VERDICTS);
export const actionTypeEnum = pgEnum('action_type', ACTION_TYPES);
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES);
export const orgRoleEnum = pgEnum('org_role', ORG_ROLES);
export const projectRoleEnum = pgEnum('project_role', PROJECT_ROLES);
export const agentRoleEnum = pgEnum('agent_role', AGENT_ROLES);
export const contextItemStatusEnum = pgEnum('context_item_status', CONTEXT_ITEM_STATUSES);
export const artifactKindEnum = pgEnum('artifact_kind', ARTIFACT_KINDS);
