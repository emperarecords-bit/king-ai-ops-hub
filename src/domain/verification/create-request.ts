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
import type { CatalogResolver } from './catalog';
import type { NewVerificationRequest, VerificationRequest } from './ingest-types';
import type { VerificationStore } from './ports';
import { canonicalRepoIdentity, repoIdentityEquals } from './repo-identity';

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

export type CreateRequestRejectionCode =
  | 'invalid_input'
  | 'task_not_in_project'
  | 'repo_not_authorized'
  | 'no_repo_binding'
  /** The server could not resolve a trusted catalog for this project — fail closed, never create an
   *  unpinnable contract. */
  | 'catalog_unavailable'
  | 'contract_conflict';

/** Fields normalized from untrusted input, before the server-resolved catalog identity is pinned. */
type NormalizedInput = Omit<NewVerificationRequest, 'catalogVersion' | 'catalogDigest'>;

export interface CreateRequestOutcome {
  /** true = this call created a new contract; false = an identical contract already existed (idempotent). */
  readonly created: boolean;
  readonly request: VerificationRequest | null;
  readonly rejection: { readonly code: CreateRequestRejectionCode; readonly message: string } | null;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Validate a string list WITHOUT silently dropping entries: any blank or non-string entry is an error
 * (a caller must send a clean list, not one the Hub quietly rewrites). An explicitly empty list is
 * allowed only when `allowEmpty` (required artifacts may legitimately be none).
 */
function validateList(
  v: readonly string[] | undefined,
  label: string,
  allowEmpty: boolean,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const arr = v ?? [];
  if (!Array.isArray(arr)) return { ok: false, message: `${label} must be an array of non-empty strings` };
  if (!allowEmpty && arr.length === 0) return { ok: false, message: `${label} must declare at least one entry` };
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== 'string' || x.trim() === '') {
      return { ok: false, message: `${label} must not contain blank or non-string entries` };
    }
    out.push(x.trim());
  }
  if (new Set(out).size !== out.length) return { ok: false, message: `${label} must not contain duplicate entries` };
  return { ok: true, value: out };
}

function validate(input: VerificationRequestInput): { ok: true; value: NormalizedInput } | { ok: false; message: string } {
  const taskId = (input.taskId ?? '').trim();
  if (!UUID_RE.test(taskId)) return { ok: false, message: 'taskId must be a UUID' };
  const repoFullName = (input.repoFullName ?? '').trim();
  if (!REPO_RE.test(repoFullName)) return { ok: false, message: 'repoFullName must be "owner/repo"' };
  const commitSha = (input.commitSha ?? '').trim().toLowerCase();
  if (!COMMIT_RE.test(commitSha)) return { ok: false, message: 'commitSha must be a full 40-hex commit SHA' };
  const checks = validateList(input.requiredChecks, 'requiredChecks', false);
  if (!checks.ok) return checks;
  const artifacts = validateList(input.requiredArtifacts, 'requiredArtifacts', true);
  if (!artifacts.ok) return artifacts;
  return { ok: true, value: { taskId, repoFullName, commitSha, requiredChecks: checks.value, requiredArtifacts: artifacts.value, allowDirty: input.allowDirty === true } };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/** Does the stored contract match the requested one? (list order does not matter). */
function contractsEqual(a: VerificationRequest, b: NewVerificationRequest): boolean {
  return (
    repoIdentityEquals(a.repoFullName, b.repoFullName) &&
    a.expectedCommitSha === b.commitSha &&
    a.allowDirty === b.allowDirty &&
    a.catalogVersion === b.catalogVersion &&
    a.catalogDigest === b.catalogDigest &&
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
  catalog: CatalogResolver,
  ctx: Pick<TenantContext, 'orgId' | 'projectId' | 'userId'>,
  input: VerificationRequestInput,
): Promise<CreateRequestOutcome> {
  const v = validate(input);
  if (!v.ok) return { created: false, request: null, rejection: { code: 'invalid_input', message: v.message } };
  const n = v.value;

  if (!(await store.taskExistsInTenant(ctx.orgId, ctx.projectId, n.taskId))) {
    return { created: false, request: null, rejection: { code: 'task_not_in_project', message: 'task does not exist in this project' } };
  }

  // Resolve the trusted, server-side catalog for this project and pin its (version, digest). The
  // catalog is NEVER supplied by the caller. If none resolves, fail closed rather than create an
  // unpinnable contract. Every required check name must exist in the pinned catalog (D4).
  const resolved = catalog.current(ctx.projectId);
  if (!resolved) {
    return { created: false, request: null, rejection: { code: 'catalog_unavailable', message: 'no trusted command catalog is configured for this project' } };
  }
  const unknown = n.requiredChecks.filter((name) => !(name in resolved.commands));
  if (unknown.length > 0) {
    return { created: false, request: null, rejection: { code: 'invalid_input', message: `unknown required check name(s) not in catalog ${resolved.version}: ${unknown.join(', ')}` } };
  }

  // The repository must be one the project has a TRUSTED link to (github_repo_links). No links at all is
  // an explicit failure (no authorized binding exists), not a silent accept; a link set that does not
  // include the requested repo rejects an unrelated repository. Comparison is case-insensitive (GitHub
  // owner/repo are case-insensitive).
  const linked = await store.linkedRepoFullNames(ctx.orgId, ctx.projectId);
  if (linked.length === 0) {
    return { created: false, request: null, rejection: { code: 'no_repo_binding', message: 'no repository is linked to this project; a verification contract cannot be created' } };
  }
  if (!linked.some((l) => repoIdentityEquals(l, n.repoFullName))) {
    return { created: false, request: null, rejection: { code: 'repo_not_authorized', message: 'repoFullName is not an authorized repository for this project' } };
  }

  // Bind the CANONICAL repository identity (the trusted link's spelling) and the server-resolved
  // catalog identity onto the contract, so a retry is idempotent and evidence binds to one stable
  // identity. Neither the repo casing nor the catalog identity comes from the caller's payload.
  const contract: NewVerificationRequest = {
    ...n,
    repoFullName: canonicalRepoIdentity(n.repoFullName, linked),
    catalogVersion: resolved.version,
    catalogDigest: resolved.digest,
  };

  const existing = await store.findRequestByTaskCommit(ctx.orgId, ctx.projectId, contract.taskId, contract.commitSha);
  if (existing) return contractsEqual(existing, contract) ? { created: false, request: existing, rejection: null } : conflict();

  const { request, inserted } = await store.createRequest(ctx.orgId, ctx.projectId, ctx.userId, contract);
  if (!inserted) return contractsEqual(request, contract) ? { created: false, request, rejection: null } : conflict();
  return { created: true, request, rejection: null };
}
