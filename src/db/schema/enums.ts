import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACTION_TYPES,
  AGENT_ROLES,
  APPROVAL_STATUSES,
  ARTIFACT_KINDS,
  CADENCES,
  CONTENT_FIDELITIES,
  CONTEXT_ITEM_STATUSES,
  DOCUMENT_INDEX_STATUSES,
  DECISION_APPLICABILITY,
  DECISION_CONFIDENCE,
  DECISION_SCOPES,
  DECISION_STATUSES,
  DECISION_TYPES,
  DEPENDENCY_KINDS,
  EXTRACTION_STATUSES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DOCUMENT_SOURCES,
  DOCUMENT_JOB_STATUSES,
  FLAGSHIP_CATEGORIES,
  KNOWLEDGE_DISCLOSURES,
  KNOWLEDGE_EPISTEMIC_BASES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCOPE_KINDS,
  KNOWLEDGE_SCOPES,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_VERIFICATIONS,
  MESSAGE_ROLES,
  MILESTONE_STATUSES,
  MODEL_TIERS,
  OBJECTIVE_STATUSES,
  WORK_ITEM_CONDITIONS,
  ORG_ROLES,
  PROJECT_ROLES,
  RETRIEVAL_MODES,
  REVIEW_VERDICTS,
  RUN_JOB_STATUSES,
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
export const workItemConditionEnum = pgEnum('work_item_condition', WORK_ITEM_CONDITIONS);
export const milestoneStatusEnum = pgEnum('milestone_status', MILESTONE_STATUSES);
export const knowledgeScopeEnum = pgEnum('knowledge_scope', KNOWLEDGE_SCOPES);
export const knowledgeKindEnum = pgEnum('knowledge_kind', KNOWLEDGE_KINDS);
export const knowledgeStatusEnum = pgEnum('knowledge_status', KNOWLEDGE_STATUSES);
export const knowledgeSourceEnum = pgEnum('knowledge_source', KNOWLEDGE_SOURCES);
export const knowledgeEpistemicBasisEnum = pgEnum('knowledge_epistemic_basis', KNOWLEDGE_EPISTEMIC_BASES);
export const knowledgeVerificationEnum = pgEnum('knowledge_verification', KNOWLEDGE_VERIFICATIONS);
export const knowledgeScopeKindEnum = pgEnum('knowledge_scope_kind', KNOWLEDGE_SCOPE_KINDS);
export const knowledgeDisclosureEnum = pgEnum('knowledge_disclosure', KNOWLEDGE_DISCLOSURES);
export const cadenceEnum = pgEnum('cadence', CADENCES);
export const documentKindEnum = pgEnum('document_kind', DOCUMENT_KINDS);
export const documentStatusEnum = pgEnum('document_status', DOCUMENT_STATUSES);
export const retrievalModeEnum = pgEnum('retrieval_mode', RETRIEVAL_MODES);
export const documentSourceEnum = pgEnum('document_source', DOCUMENT_SOURCES);
export const documentJobStatusEnum = pgEnum('document_job_status', DOCUMENT_JOB_STATUSES);
export const documentIndexStatusEnum = pgEnum('document_index_status', DOCUMENT_INDEX_STATUSES);
export const contentFidelityEnum = pgEnum('content_fidelity', CONTENT_FIDELITIES);
export const dependencyKindEnum = pgEnum('dependency_kind', DEPENDENCY_KINDS);
export const decisionStatusEnum = pgEnum('decision_status', DECISION_STATUSES);
export const decisionTypeEnum = pgEnum('decision_type', DECISION_TYPES);
export const decisionApplicabilityEnum = pgEnum('decision_applicability', DECISION_APPLICABILITY);
export const decisionScopeEnum = pgEnum('decision_scope', DECISION_SCOPES);
export const decisionConfidenceEnum = pgEnum('decision_confidence', DECISION_CONFIDENCE);
export const extractionStatusEnum = pgEnum('extraction_status', EXTRACTION_STATUSES);
export const runJobStatusEnum = pgEnum('run_job_status', RUN_JOB_STATUSES);
