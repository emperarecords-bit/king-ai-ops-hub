import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTION_TYPES,
  AGENT_ROLES,
  APPROVAL_STATUSES,
  ARTIFACT_KINDS,
  CADENCES,
  CONTEXT_ITEM_STATUSES,
  DECISION_STATUSES,
  DECISION_TYPES,
  DEPENDENCY_KINDS,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  FLAGSHIP_CATEGORIES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCOPES,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  MESSAGE_ROLES,
  MILESTONE_STATUSES,
  MODEL_TIERS,
  OBJECTIVE_STATUSES,
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
export const modelTierEnum = pgEnum('model_tier', MODEL_TIERS);
export const flagshipCategoryEnum = pgEnum('flagship_category', FLAGSHIP_CATEGORIES);
export const objectiveStatusEnum = pgEnum('objective_status', OBJECTIVE_STATUSES);
export const milestoneStatusEnum = pgEnum('milestone_status', MILESTONE_STATUSES);
export const knowledgeScopeEnum = pgEnum('knowledge_scope', KNOWLEDGE_SCOPES);
export const knowledgeKindEnum = pgEnum('knowledge_kind', KNOWLEDGE_KINDS);
export const knowledgeStatusEnum = pgEnum('knowledge_status', KNOWLEDGE_STATUSES);
export const knowledgeSourceEnum = pgEnum('knowledge_source', KNOWLEDGE_SOURCES);
export const cadenceEnum = pgEnum('cadence', CADENCES);
export const documentKindEnum = pgEnum('document_kind', DOCUMENT_KINDS);
export const documentStatusEnum = pgEnum('document_status', DOCUMENT_STATUSES);
export const dependencyKindEnum = pgEnum('dependency_kind', DEPENDENCY_KINDS);
export const decisionStatusEnum = pgEnum('decision_status', DECISION_STATUSES);
export const decisionTypeEnum = pgEnum('decision_type', DECISION_TYPES);
