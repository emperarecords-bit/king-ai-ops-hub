import { createHash } from 'node:crypto';
import type { ExecutorRiskClass, ExecutionMode } from './executor-contract';
import type { CanonicalFileWriteAction } from './file-write-action';

export const FILE_WRITE_CONFIRMATION_LIFETIME_MS = 10 * 60 * 1000;
const DOMAIN = 'king-ai-ops-hub:file-write-confirmation:v1';

export interface FileWriteConfirmationFields {
  readonly confirmationId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly executorId: 'file_write';
  readonly riskClass: ExecutorRiskClass;
  readonly mode: ExecutionMode;
  readonly confirmedAt: string;
  readonly expiresAt: string;
  readonly action: CanonicalFileWriteAction;
}

const field = (name: string, value: string): string => `${name}:${Buffer.byteLength(value, 'utf8')}:${value}`;

/** Domain-separated, ordered, length-prefixed UTF-8 representation. */
export function canonicalConfirmationBytes(value: FileWriteConfirmationFields): Buffer {
  const fields = [
    ['confirmation_id', value.confirmationId], ['org_id', value.orgId], ['project_id', value.projectId],
    ['actor_id', value.actorId], ['executor_id', value.executorId], ['action', value.action.operation],
    ['target', value.action.normalizedTarget], ['payload_sha256', value.action.payloadSha256],
    ['precondition_sha256', value.action.expectedCurrentSha256 ?? 'absent'],
    ['desired_sha256', value.action.desiredPostconditionSha256], ['risk_class', value.riskClass],
    ['mode', value.mode], ['confirmed_at', value.confirmedAt], ['expires_at', value.expiresAt],
  ] as const;
  return Buffer.from([DOMAIN, ...fields.map(([name, v]) => field(name, v))].join('\n'), 'utf8');
}

export const confirmationBindingSha256 = (value: FileWriteConfirmationFields): string =>
  createHash('sha256').update(canonicalConfirmationBytes(value)).digest('hex');

export function validateConfirmationUse(
  value: FileWriteConfirmationFields,
  expectedBindingSha256: string,
  now: Date,
  consumedIds: ReadonlySet<string>,
): { readonly allowed: true; readonly consumedIds: ReadonlySet<string> } | { readonly allowed: false; readonly reason: string } {
  const confirmedAt = Date.parse(value.confirmedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(confirmedAt) || !Number.isFinite(expiresAt) || expiresAt - confirmedAt !== FILE_WRITE_CONFIRMATION_LIFETIME_MS) return { allowed: false, reason: 'confirmation window is invalid' };
  if (now.getTime() >= expiresAt) return { allowed: false, reason: 'confirmation is expired' };
  if (consumedIds.has(value.confirmationId)) return { allowed: false, reason: 'confirmation was already consumed' };
  if (confirmationBindingSha256(value) !== expectedBindingSha256) return { allowed: false, reason: 'confirmation binding mismatch' };
  return { allowed: true, consumedIds: new Set([...consumedIds, value.confirmationId]) };
}
