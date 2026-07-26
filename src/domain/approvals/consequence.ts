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
