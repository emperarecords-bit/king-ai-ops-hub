import { createHash } from 'node:crypto';
import { validateFileWriteRelativePath } from './file-write-path-policy';

export const FILE_WRITE_MAX_PAYLOAD_BYTES = 256 * 1024;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export type FileWriteOperation = 'create' | 'replace';

export interface CanonicalFileWriteAction {
  readonly operation: FileWriteOperation;
  readonly normalizedTarget: string;
  readonly targetCollisionKey: string;
  readonly payload: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly expectedCurrentSha256: string | null;
  readonly desiredPostconditionSha256: string;
}

export type FileWriteActionDecision =
  | { readonly allowed: true; readonly action: CanonicalFileWriteAction }
  | { readonly allowed: false; readonly reason: string };

const hasUnpairedSurrogate = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
export const sha256Utf8 = (value: string): string => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');

export function canonicalizeFileWriteAction(input: {
  readonly operation: unknown;
  readonly target: unknown;
  readonly payload: unknown;
  readonly expectedCurrentSha256?: unknown;
  readonly desiredPostconditionSha256?: unknown;
}): FileWriteActionDecision {
  if (input.operation !== 'create' && input.operation !== 'replace') return { allowed: false, reason: 'only create and replace are supported' };
  const path = validateFileWriteRelativePath(input.target);
  if (!path.allowed) return path;
  if (typeof input.payload !== 'string' || hasUnpairedSurrogate(input.payload) || input.payload.includes('\0')) return { allowed: false, reason: 'payload must be well-formed UTF-8 text' };
  const payloadBytes = Buffer.byteLength(input.payload, 'utf8');
  if (payloadBytes > FILE_WRITE_MAX_PAYLOAD_BYTES) return { allowed: false, reason: 'payload exceeds 256 KiB' };
  const payloadSha256 = sha256Utf8(input.payload);
  if (input.desiredPostconditionSha256 !== undefined && input.desiredPostconditionSha256 !== payloadSha256) return { allowed: false, reason: 'desired postcondition hash must equal exact payload bytes' };
  if (input.operation === 'create' && input.expectedCurrentSha256 != null) return { allowed: false, reason: 'create requires an absent-target precondition' };
  if (input.operation === 'replace' && (typeof input.expectedCurrentSha256 !== 'string' || !SHA256_HEX.test(input.expectedCurrentSha256))) return { allowed: false, reason: 'replace requires an exact lowercase SHA-256 precondition' };
  return {
    allowed: true,
    action: {
      operation: input.operation,
      normalizedTarget: path.normalizedPath,
      targetCollisionKey: path.collisionKey,
      payload: input.payload,
      payloadBytes,
      payloadSha256,
      expectedCurrentSha256: input.operation === 'replace' ? input.expectedCurrentSha256 as string : null,
      desiredPostconditionSha256: payloadSha256,
    },
  };
}
