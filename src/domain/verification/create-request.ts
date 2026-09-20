/**
 * VER-002 — verification REQUEST (contract) creation.
 *
 * A contract pins the exact code version and the full set of required checks/artifacts BEFORE any
 * results arrive, so ingested evidence can be bound to it and "exit 0 from one command" can never
 * masquerade as verification. This is the authorized ingress that creates that contract.
 *
 * Two guarantees:
 *  - Bound to the AUTHENTICATED tenant. org/project/creator come from the tenant context, never the
 *    payload; the caller can only create contracts inside a project they are a member of (the route's
 *    requireTenant), and the DB RLS with-check independently pins org/project on insert.
 *  - The contract is IMMUTABLE. There is no update path; the store grants the app role INSERT/SELECT
 *    only. A re-create for the same (task, commit) returns the existing contract when the declared
 *    checks/artifacts are identical (idempotent), and is REJECTED as a conflict when they differ — so
 *    an existing contract can never be silently altered.
 */
import type { TenantContext } from '@/types/domain';
import type { NewVerificationRequest, VerificationRequest } from './ingest-types';
import type { VerificationStore } from './ports';

/** Untrusted create input (org/project/creator are NOT here — they come from the tenant context). */
export interface VerificationRequestInput {
  readonly taskId: string;
  readonly repoFullName: string;
  readonly commitSha: string;
  readonly requiredChecks: readonly string[];
  readonly requiredArtifacts: readonly string[];
  /** Reserved; dirty trees are rejected at ingest regardless. Defaults to false. */
  readonly allowDirty?: boolean;
}

export type CreateRequestRejectionCode = 'invalid_input' | 'task_not_in_project' | 'contract_conflict';

export interface CreateRequestOutcome {
  /** true = this call created a new contract; false = an identical contract already existed (idempotent). */
  readonly created: boolean;
  readonly request: VerificationRequest | null;
  readonly rejection: { readonly code: CreateRequestRejectionCode; readonly message: string } | null;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function normalizeList(v: readonly string[] | undefined): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (s) out.push(s);
  }
  return out;
}

function validate(input: VerificationRequestInput): { ok: true; value: NewVerificationRequest } | { ok: false; message: string } {
  const taskId = (input.taskId ?? '').trim();
  if (!UUID_RE.test(taskId)) return { ok: false, message: 'taskId must be a UUID' };
  const repoFullName = (input.repoFullName ?? '').trim();
  if (!REPO_RE.test(repoFullName)) return { ok: false, message: 'repoFullName must be "owner/repo"' };
  const commitSha = (input.commitSha ?? '').trim().toLowerCase();
  if (!COMMIT_RE.test(commitSha)) return { ok: false, message: 'commitSha must be a full 40-hex commit SHA' };
  const requiredChecks = normalizeList(input.requiredChecks);
  if (requiredChecks.length === 0) return { ok: false, message: 'requiredChecks must declare at least one check' };
  if (new Set(requiredChecks).size !== requiredChecks.length) return { ok: false, message: 'requiredChecks must not contain duplicates' };
  const requiredArtifacts = normalizeList(input.requiredArtifacts);
  if (new Set(requiredArtifacts).size !== requiredArtifacts.length) return { ok: false, message: 'requiredArtifacts must not contain duplicates' };
  return { ok: true, value: { taskId, repoFullName, commitSha, requiredChecks, requiredArtifacts, allowDirty: input.allowDirty === true } };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/** Does the stored contract match the requested one? (list order does not matter). */
function contractsEqual(a: VerificationRequest, b: NewVerificationRequest): boolean {
  return (
    a.repoFullName === b.repoFullName &&
    a.expectedCommitSha === b.commitSha &&
    a.allowDirty === b.allowDirty &&
    sameSet(a.requiredChecks, b.requiredChecks) &&
    sameSet(a.requiredArtifacts, b.requiredArtifacts)
  );
}

const conflict = (): CreateRequestOutcome => ({
  created: false,
  request: null,
  rejection: {
    code: 'contract_conflict',
    message: 'a verification request already exists for this task and commit with a different contract',
  },
});

export async function createVerificationRequest(
  store: VerificationStore,
  ctx: Pick<TenantContext, 'orgId' | 'projectId' | 'userId'>,
  input: VerificationRequestInput,
): Promise<CreateRequestOutcome> {
  const v = validate(input);
  if (!v.ok) return { created: false, request: null, rejection: { code: 'invalid_input', message: v.message } };
  const n = v.value;

  if (!(await store.taskExistsInTenant(ctx.orgId, ctx.projectId, n.taskId))) {
    return { created: false, request: null, rejection: { code: 'task_not_in_project', message: 'task does not exist in this project' } };
  }

  const existing = await store.findRequestByTaskCommit(ctx.orgId, ctx.projectId, n.taskId, n.commitSha);
  if (existing) return contractsEqual(existing, n) ? { created: false, request: existing, rejection: null } : conflict();

  const { request, inserted } = await store.createRequest(ctx.orgId, ctx.projectId, ctx.userId, n);
  if (!inserted) return contractsEqual(request, n) ? { created: false, request, rejection: null } : conflict();
  return { created: true, request, rejection: null };
}
