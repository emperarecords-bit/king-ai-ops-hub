import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeV1 } from '@/lib/canonical';
import {
  CANONICAL_REPOSITORY_ID,
  buildSourceManifestFromGit,
  parseSourceManifest,
  serializeSourceManifest,
} from '../../scripts/backup/source-manifest';
import { MigrationReadError } from '../../scripts/backup/migration-hash';
import {
  LEGACY_CONTENT_DOMAIN,
  LEGACY_SIGN_DOMAIN,
  deriveAttestationId,
} from '../../scripts/backup/legacy-attestation-canonical';

/**
 * Focused final-scope-fix coverage:
 *  - Source-manifest repository identity is a fixed canonical constant, matched EXACTLY by the validator and
 *    never derived from a mutable remote.
 *  - The finalized inactive 0004 draft carries the known application identity, no production scope, and still
 *    authorizes nothing; its committed digests are internally consistent.
 *  - The exact application id and repository id are part of the attestation identity (changing either changes
 *    the derived attestation id).
 */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const contentDigest = (p: Record<string, unknown>) => {
  const { attestationId: _id, ...rest } = p as Record<string, unknown> & { attestationId?: unknown };
  void _id;
  return sha256(LEGACY_CONTENT_DOMAIN + canonicalizeV1(rest));
};

describe('source-manifest repository identity is a canonical constant, matched exactly', () => {
  const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');

  it('the canonical repository ID is carried by the manifest and accepted by the validator', () => {
    expect(CANONICAL_REPOSITORY_ID).toBe('emperarecords-bit/king-ai-ops-hub');
    expect(manifest.repositoryId).toBe(CANONICAL_REPOSITORY_ID);
    expect(parseSourceManifest(serializeSourceManifest(manifest)).repositoryId).toBe(CANONICAL_REPOSITORY_ID);
  });

  // Every non-canonical identity is rejected at parse time (z.literal accepts only the exact string).
  const rejected: Record<string, string> = {
    'repository URL': 'https://github.com/emperarecords-bit/king-ai-ops-hub.git',
    'git remote alias': 'origin',
    'wrong owner': 'someone-else/king-ai-ops-hub',
    'wrong repository': 'emperarecords-bit/some-other-repo',
    'wrong capitalization': 'emperarecords-bit/King-AI-Ops-Hub',
    'leading/trailing whitespace': ' emperarecords-bit/king-ai-ops-hub ',
    'embedded credentials': 'https://user:pass@github.com/emperarecords-bit/king-ai-ops-hub',
    'prefix value': 'emperarecords-bit/king-ai-ops-hub-staging',
    'wildcard value': 'emperarecords-bit/*',
  };
  for (const [label, badId] of Object.entries(rejected)) {
    it(`rejects a manifest whose repositoryId is a ${label}`, () => {
      const tampered = { ...manifest, repositoryId: badId };
      expect(() => parseSourceManifest(tampered)).toThrow();
    });
  }

  it('a mutable remote name cannot determine identity: the producer stamps the constant and rejects any other expected id', () => {
    // No matter what remote/dir the checkout has, the produced identity is the constant.
    expect(buildSourceManifestFromGit('HEAD', 'drizzle', CANONICAL_REPOSITORY_ID).repositoryId).toBe(CANONICAL_REPOSITORY_ID);
    // A narrowly-trusted config input that is anything other than the canonical id is rejected (not adopted).
    expect(() => buildSourceManifestFromGit('HEAD', 'drizzle', 'origin')).toThrow(MigrationReadError);
    expect(() => buildSourceManifestFromGit('HEAD', 'drizzle', 'someone-else/king-ai-ops-hub')).toThrow(MigrationReadError);
    expect(() => buildSourceManifestFromGit('HEAD', 'drizzle', 'https://github.com/emperarecords-bit/king-ai-ops-hub')).toThrow(MigrationReadError);
  }, 15_000);
});

describe('finalized inactive 0004 draft', () => {
  const draftPath = join(process.cwd(), 'scripts', 'backup', 'legacy-drafts', '0004_knowledge_k1.attestation.draft.json');
  const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as {
    status: string;
    signedPayload: Record<string, unknown>;
    reviewDigests: { derivedDraftAttestationId: string; placeholderCanonicalPayloadHash: string };
  };
  const payload = draft.signedPayload;

  it('uses applicationId = king-ai-ops-hub and repositoryId = the canonical id (no leftover placeholder)', () => {
    expect(payload.applicationId).toBe('king-ai-ops-hub');
    expect(payload.applicationId).not.toBe('REPLACE_WITH_TARGET_APPLICATION_ID');
    expect(payload.repositoryId).toBe(CANONICAL_REPOSITORY_ID);
  });

  it('has no production scope', () => {
    expect(payload.allowedEnvironments).toEqual(['development', 'staging']);
    expect(payload.allowedEnvironments as string[]).not.toContain('production');
  });

  it('still authorizes nothing: unsigned, inactive, and carries no signature', () => {
    expect(draft.status).toBe('UNSIGNED_INACTIVE');
    expect(Object.prototype.hasOwnProperty.call(payload, 'signature')).toBe(false);
    // Ceremony fields remain owner-controlled placeholders (no real signer identity present).
    expect(payload.keyId).toBe('REPLACE_WITH_OWNER_KEY_ID');
    expect(payload.approvedAt).toBe('REPLACE_WITH_APPROVAL_TIMESTAMP');
  });

  it('committed digests are internally consistent with the finalized payload', () => {
    const derived = `lma1_${contentDigest(payload)}`;
    expect(derived).toBe(payload.attestationId);
    expect(derived).toBe(draft.reviewDigests.derivedDraftAttestationId);
    const canonicalHash = sha256(LEGACY_SIGN_DOMAIN + canonicalizeV1(payload));
    expect(canonicalHash).toBe(draft.reviewDigests.placeholderCanonicalPayloadHash);
  });
});

describe('exact application id and repository id are part of the attestation identity', () => {
  const draftPath = join(process.cwd(), 'scripts', 'backup', 'legacy-drafts', '0004_knowledge_k1.attestation.draft.json');
  const base = (JSON.parse(readFileSync(draftPath, 'utf8')) as { signedPayload: Record<string, unknown> }).signedPayload;

  it('changing the exact application id changes the derived attestation id', () => {
    const id = deriveAttestationId(base as never);
    const changed = deriveAttestationId({ ...base, applicationId: 'king-ai-ops-hub-other' } as never);
    expect(changed).not.toBe(id);
  });

  it('changing the exact repository id changes the attestation binding (derived id)', () => {
    const id = deriveAttestationId(base as never);
    const changed = deriveAttestationId({ ...base, repositoryId: 'someone-else/king-ai-ops-hub' } as never);
    expect(changed).not.toBe(id);
  });
});
