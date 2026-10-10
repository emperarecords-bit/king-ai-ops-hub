import 'server-only';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { EXECUTOR_RISK_BY_ACTION } from '@/domain/execution/executor-policy';
import { listSupabaseProjectLinks } from './links';
import { validateApprovedSqlStatement, type ApprovedSqlPolicyResult } from './sql-policy';

/**
 * Approved-SQL validation surface (Phase 2C, Option B — validation/dry-run ONLY). It resolves the target project
 * against the workspace's links (offline, RLS-scoped), runs the AST policy, and validates the bound-parameter list
 * and the declared max-affected-rows ceiling. It is strictly SIDE-EFFECT-FREE and makes NO Supabase network call —
 * there is no live executor and no confirm action for approved SQL (see
 * docs/architecture/supabase-approved-sql-risk-model.md). The report states, explicitly, that live execution is
 * not available and why. The Supabase Management token never enters this layer.
 */

/** Hard ceiling on the declared max-affected-rows a proposal may name. Advisory in v1 (no live enforcement). */
export const APPROVED_SQL_MAX_ROWS_CEILING = 1000;

export class SupabaseProjectNotLinkedError extends Error {
  constructor(projectRef: string) {
    super(`Supabase project "${projectRef}" is not linked to this workspace.`);
    this.name = 'SupabaseProjectNotLinkedError';
  }
}

export interface ApprovedSqlValidationInput {
  readonly projectRef: string;
  readonly sql: string;
  /** Bound parameters for the statement's $N placeholders (scalar JSON only). */
  readonly params?: ReadonlyArray<string | number | boolean | null>;
  /** The caller's declared ceiling on affected rows (1..APPROVED_SQL_MAX_ROWS_CEILING). */
  readonly maxRows?: number;
}

export interface ApprovedSqlValidationReport {
  readonly projectRef: string;
  readonly policy: ApprovedSqlPolicyResult;
  /** True only when the policy passed AND parameters + maxRows are well-formed. */
  readonly accepted: boolean;
  readonly violations: readonly string[];
  readonly maxRows: number | null;
  readonly paramCount: number;
  /** The governed risk class of this action type — destructive_irreversible. */
  readonly riskClass: string;
  /** v1 is validation-only; this is always false and the reason is fixed. */
  readonly liveExecutionAvailable: false;
  readonly liveExecutionUnavailableReason: string;
  /** The reversibility position for this class — surfaced so a confirm UI could show it honestly. */
  readonly rollbackEvidence: string;
}

const LIVE_UNAVAILABLE_REASON =
  'Live execution is disabled for approved SQL: a single DML against an arbitrary linked table is not provably ' +
  'reversible (triggers, cascading foreign keys, sequences, generated columns, RLS, and concurrent readers can ' +
  'all break a compensating operation), so its honest risk class is destructive_irreversible, which the dispatch ' +
  'choke point blocks by construction. This slice validates and dry-runs only.';

const ROLLBACK_EVIDENCE =
  'No generic rollback is guaranteed. A live path would require, per action: proof the target table has no ' +
  'triggers/rules, no cascading FKs, and no generated columns; a stable primary-key predicate; a bounded row ' +
  'count; full pre-image capture; and a verified compensating operation under a statement timeout. Until that is ' +
  'proven, the action stays destructive_irreversible and cannot execute.';

/**
 * Validate an approved-SQL proposal. Pure/offline: it never contacts Supabase and never mutates anything. Throws
 * SupabaseProjectNotLinkedError when the target project is not linked to the caller's workspace.
 */
export async function validateWorkspaceApprovedSql(
  tx: DbTx,
  ctx: TenantContext,
  input: ApprovedSqlValidationInput,
): Promise<ApprovedSqlValidationReport> {
  const links = await listSupabaseProjectLinks(tx, ctx);
  if (!links.some((l) => l.projectRef === input.projectRef)) {
    throw new SupabaseProjectNotLinkedError(input.projectRef);
  }

  const policy = validateApprovedSqlStatement(input.sql);
  const violations: string[] = [...policy.violations];

  // Max-rows ceiling (advisory in v1; still validated so a proposal can never name an unbounded/invalid ceiling).
  let maxRows: number | null = null;
  if (input.maxRows !== undefined) {
    if (!Number.isInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > APPROVED_SQL_MAX_ROWS_CEILING) {
      violations.push(`maxRows must be an integer in 1..${APPROVED_SQL_MAX_ROWS_CEILING}`);
    } else {
      maxRows = input.maxRows;
    }
  } else {
    violations.push('maxRows is required (the proposal must declare a bounded affected-row ceiling)');
  }

  // Strict parameter list: the supplied params must exactly cover the referenced $N placeholders.
  const params = input.params ?? [];
  const paramCount = params.length;
  if (policy.ok) {
    if (paramCount !== policy.referencedParameters.length) {
      violations.push(`parameter count mismatch: statement references ${policy.referencedParameters.length} ($N) but ${paramCount} were supplied`);
    }
    for (const p of params) {
      const ok = p === null || typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean';
      if (!ok) { violations.push('parameters must be scalar values (string, number, boolean, or null)'); break; }
    }
  }

  return {
    projectRef: input.projectRef,
    policy,
    accepted: policy.ok && violations.length === 0,
    violations,
    maxRows,
    paramCount,
    riskClass: EXECUTOR_RISK_BY_ACTION.supabase_sql,
    liveExecutionAvailable: false,
    liveExecutionUnavailableReason: LIVE_UNAVAILABLE_REASON,
    rollbackEvidence: ROLLBACK_EVIDENCE,
  };
}
