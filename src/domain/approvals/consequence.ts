import { type ActionType } from '@/types/domain';

/**
 * The evidence-backed consequence shape (Approvals refinement #3). The Hub may explain only
 * consequences it can *establish* — from the proposal payload, a connected system, or explicit
 * policy — never from an action-type template that merely sounds right. So each claim is either
 * established (with a value, source, and confidence) or explicitly not established; nothing is
 * asserted by default. Notably, reversibility is NOT inferred from the action type: overwriting an
 * unversioned file is not reversible, and the payload alone cannot prove a rollback path.
 *
 * This is the model the approval assessment retains. The interface should surface it as a coherent
 * read, never as a wall of fields.
 */

export type ClaimSource = 'proposal-payload' | 'connected-system' | 'policy' | 'none';

export interface ConsequenceClaim {
  /** What the Hub can truthfully say, or null when it cannot establish this dimension. */
  readonly value: string | null;
  /** True only when derived from real evidence — never a type-based assumption. */
  readonly established: boolean;
  readonly source: ClaimSource;
  readonly confidence: 'high' | 'medium' | 'low' | null;
}

export interface ConsequenceProfile {
  readonly actionType: ActionType;
  /** The specific system / account / file / audience / asset the action touches. */
  readonly target: ConsequenceClaim;
  readonly externalPartiesAffected: ConsequenceClaim;
  readonly dataAffected: ConsequenceClaim;
  readonly financialExposure: ConsequenceClaim;
  readonly reversibility: ConsequenceClaim;
  /** The narrow authority the operator would grant — always establishable from the proposal itself. */
  readonly authorityRequested: ConsequenceClaim;
  readonly preconditions: ConsequenceClaim;
  /** How the authorized action would actually run. In this version: no executor exists. */
  readonly executionMethod: ConsequenceClaim;
  /** Explicit list of dimensions that could NOT be established — surfaced, not hidden. */
  readonly unknowns: readonly string[];
}

const NOT_ESTABLISHED: ConsequenceClaim = { value: null, established: false, source: 'none', confidence: null };

/**
 * A consequence *level* and a decision-quality flag, derived from the profile — not a color-code of
 * the action type. `consequential` means the action reaches outside the workspace, moves money, or
 * mutates/deploys — so it warrants opening the detail, not a casual inline click. `needsClarification`
 * means the action is consequential-by-nature yet its *defining* consequence could not be established
 * (an endpoint whose effect is unknown, a charge with no amount, a delete with no predicate); the
 * proposal stays pending but is flagged as insufficiently explained — an assessment, not a status.
 */
export type ConsequenceLevel = 'routine' | 'consequential';
export interface ConsequenceReadout {
  readonly level: ConsequenceLevel;
  readonly needsClarification: boolean;
  /** One-line operator summary of what the Hub could establish (or that it could not). */
  readonly summary: string;
}

const REACHES_OUTSIDE: ReadonlyArray<ActionType> = ['email_send', 'social_publish', 'external_http'];
const CHANGES_SYSTEMS: ReadonlyArray<ActionType> = ['financial', 'db_mutation', 'destructive', 'deployment', 'git_push', 'git_pr'];

/**
 * Does the payload carry a material parameter the compact queue reference does not surface — content,
 * a diff, recipients, an amount, a predicate, an environment, a URL, etc.? The queue shows the
 * summary and the consequence read, never payload *values*, so any non-trivial payload field is
 * "hidden" for the purpose of an inline decision. A value is material when it is a non-empty string,
 * a non-zero number, `true`, or a non-empty array/object; empty/null/false fields are cosmetic.
 */
export function hasHiddenMaterialParameters(payload: Record<string, unknown>): boolean {
  return Object.values(payload ?? {}).some((v) => {
    if (v == null || v === false || v === '' || v === 0) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  });
}

/**
 * A decision may occur **inline** only when no material authorization context is hidden elsewhere.
 * Evidence-driven, not tied to the action type: a routine, well-established proposal whose every
 * material parameter is already visible may be authorized from the queue; if the operator would have
 * to open the payload/diff/recipients/amount/predicate/environment to understand the authority, the
 * decision must happen on the detail page. A file *creation* may qualify; an overwrite with hidden
 * content may not — the difference is whether anything material is concealed, not the type.
 */
export function isInlineAuthorizable(readout: ConsequenceReadout, payload: Record<string, unknown>): boolean {
  return readout.level === 'routine' && !readout.needsClarification && !hasHiddenMaterialParameters(payload);
}

export function readConsequence(profile: ConsequenceProfile): ConsequenceReadout {
  const t = profile.actionType;
  const external = profile.externalPartiesAffected.established;
  const financial = profile.financialExposure.established;

  const consequential = external || financial || REACHES_OUTSIDE.includes(t) || CHANGES_SYSTEMS.includes(t);

  // The defining consequence for this kind of action, and whether it was established.
  let needsClarification = false;
  if (t === 'external_http') needsClarification = true; // effect on the receiving system is unknowable here
  else if (t === 'email_send' || t === 'social_publish') needsClarification = !external;
  else if (t === 'financial') needsClarification = !financial;
  else if (t === 'db_mutation' || t === 'destructive') needsClarification = !profile.dataAffected.established;
  else if (t === 'deployment') needsClarification = !profile.target.established;

  const established = [profile.externalPartiesAffected, profile.financialExposure, profile.dataAffected]
    .filter((c) => c.established)
    .map((c) => c.value!)
    .filter(Boolean);
  const summary = needsClarification
    ? 'Consequence not established — needs clarification before authorizing.'
    : established.length > 0
      ? established.join(' · ')
      : consequential
        ? 'Consequential action — review the detail before authorizing.'
        : 'Routine, workspace-internal action.';

  return { level: consequential ? 'consequential' : 'routine', needsClarification, summary };
}

function fromPayload(value: string, confidence: 'high' | 'medium' | 'low' = 'high'): ConsequenceClaim {
  return { value, established: true, source: 'proposal-payload', confidence };
}

/** First present string-ish value among candidate keys, else null. Evidence must be in the payload. */
function pick(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

/**
 * Derive a consequence profile from a stored proposal, establishing only what the payload proves.
 * Everything unproven stays `NOT_ESTABLISHED` and is named in `unknowns`. Pure and deterministic.
 */
export function assessConsequence(input: {
  type: ActionType;
  summary: string;
  payload: Record<string, unknown>;
}): ConsequenceProfile {
  const { type, summary, payload } = input;

  // The narrow authority is always establishable — it is exactly the proposal shown.
  const authorityRequested = fromPayload(`Perform this ${type} exactly as proposed: ${summary}`);

  // Target — only if a recognizable locator is present in the payload.
  const targetValue = pick(payload, ['to', 'recipient', 'path', 'file', 'url', 'endpoint', 'table', 'revision', 'environment', 'account']);
  const target = targetValue ? fromPayload(targetValue) : NOT_ESTABLISHED;

  // External parties — established only when the payload names an outside recipient/endpoint.
  const externalTarget = pick(payload, ['to', 'recipient', 'url', 'endpoint', 'audience']);
  const externalPartiesAffected =
    externalTarget && (type === 'email_send' || type === 'social_publish' || type === 'external_http')
      ? fromPayload(`Reaches an external party: ${externalTarget}`)
      : NOT_ESTABLISHED;

  // Financial exposure — only if an amount is present; never assumed from the `financial` type alone.
  const amount = pick(payload, ['amount', 'total', 'price', 'cost']);
  const financialExposure = amount ? fromPayload(`Commits ${amount}`) : NOT_ESTABLISHED;

  // Reversibility is deliberately NOT inferred — no evidence source proves it in this version.
  const reversibility = NOT_ESTABLISHED;

  // Data affected — the payload may describe a predicate/target, but never a reliable row count.
  const predicate = pick(payload, ['where', 'predicate', 'filter', 'query']);
  const dataAffected =
    predicate && (type === 'db_mutation' || type === 'destructive')
      ? fromPayload(`Affects data matching: ${predicate}`)
      : NOT_ESTABLISHED;

  // Execution method — knowable from policy: this version has no automated executor.
  const executionMethod: ConsequenceClaim = {
    value: 'No automated executor exists yet — authorizing records intent; execution happens separately.',
    established: true,
    source: 'policy',
    confidence: 'high',
  };

  const preconditions = NOT_ESTABLISHED;

  const dims: [string, ConsequenceClaim][] = [
    ['target', target],
    ['external parties affected', externalPartiesAffected],
    ['data affected', dataAffected],
    ['financial exposure', financialExposure],
    ['reversibility', reversibility],
    ['preconditions', preconditions],
  ];
  const unknowns = dims.filter(([, c]) => !c.established).map(([label]) => label);

  return {
    actionType: type,
    target,
    externalPartiesAffected,
    dataAffected,
    financialExposure,
    reversibility,
    authorityRequested,
    preconditions,
    executionMethod,
    unknowns,
  };
}
