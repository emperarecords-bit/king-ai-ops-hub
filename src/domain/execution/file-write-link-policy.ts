/** Pure policy over evidence supplied by a future no-follow filesystem inspector. No I/O occurs here. */
export type InspectedPathKind = 'regular_file' | 'directory' | 'missing' | 'symlink' | 'junction' | 'reparse_point' | 'special' | 'unknown';

export interface PathComponentEvidence {
  readonly normalizedPath: string;
  readonly kind: InspectedPathKind;
  readonly identity: string | null;
  readonly parentIdentity: string | null;
  readonly hardLinkCount: number | null;
}

export interface FileWriteInspectionEvidence {
  readonly components: readonly PathComponentEvidence[];
  readonly target: PathComponentEvidence;
}

export type FileWriteInspectionDecision =
  | { readonly allowed: true; readonly identityChain: readonly string[] }
  | { readonly allowed: false; readonly reason: string };

const DENIED_KINDS = new Set<InspectedPathKind>(['symlink', 'junction', 'reparse_point', 'special', 'unknown']);

export function evaluateFileWriteInspection(evidence: FileWriteInspectionEvidence): FileWriteInspectionDecision {
  if (evidence.components.length === 0) return { allowed: false, reason: 'path inspection evidence is empty' };
  const chain = [...evidence.components, evidence.target];
  const identities: string[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const item = chain[i]!;
    if (!item.identity || !item.parentIdentity || item.hardLinkCount === null) return { allowed: false, reason: 'path metadata is incomplete' };
    if (DENIED_KINDS.has(item.kind)) return { allowed: false, reason: `unsafe path kind: ${item.kind}` };
    if (i < evidence.components.length && item.kind !== 'directory') return { allowed: false, reason: 'every parent component must be a directory' };
    if (i === evidence.components.length && item.kind !== 'regular_file' && item.kind !== 'missing') return { allowed: false, reason: 'target must be a regular file or proven missing' };
    if (item.kind === 'regular_file' && item.hardLinkCount !== 1) return { allowed: false, reason: 'hard-linked files are denied' };
    if (i > 0 && item.parentIdentity !== chain[i - 1]!.identity) return { allowed: false, reason: 'path identity chain is inconsistent' };
    identities.push(item.identity);
  }
  return { allowed: true, identityChain: identities };
}

export function identitiesRemainStable(captured: readonly string[], current: readonly string[]): boolean {
  return captured.length > 0 && captured.length === current.length && captured.every((identity, index) => identity === current[index]);
}
