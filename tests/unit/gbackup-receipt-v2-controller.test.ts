import { describe, expect, it } from 'vitest';
import { ControllerImageBindingError, imageRepositoryNamespace, validateControllerImageBinding } from '../../scripts/backup/receipt-v2-controller';

const REF = 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC';
const NS = 'registry.fly.io/king-ai-ops-hub-staging';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ok = () => ({ targetImageRef: REF, targetImageDigest: DIGEST, resolvedImageRef: REF, resolvedImageDigest: DIGEST, deployImageRef: REF, expectedRegistryNamespace: NS });

describe('G-Backup-B1 controller image-binding validation', () => {
  it('verifies the exact ref→digest binding and the exact deploy reference', () => {
    expect(validateControllerImageBinding(ok())).toEqual({ targetImageRef: REF, targetImageDigest: DIGEST });
  });
  it('rejects a resolved-reference mismatch', () => {
    expect(() => validateControllerImageBinding({ ...ok(), resolvedImageRef: `${REF}-other` })).toThrow(ControllerImageBindingError);
  });
  it('rejects a resolved-digest mismatch', () => {
    expect(() => validateControllerImageBinding({ ...ok(), resolvedImageDigest: `sha256:${'b'.repeat(64)}` })).toThrow(ControllerImageBindingError);
  });
  it('rejects a deploy reference that differs from the signed reference', () => {
    expect(() => validateControllerImageBinding({ ...ok(), deployImageRef: `${REF}-deploy` })).toThrow(ControllerImageBindingError);
  });
  it('rejects an invalid digest form', () => {
    expect(() => validateControllerImageBinding({ ...ok(), targetImageDigest: 'notadigest' })).toThrow(ControllerImageBindingError);
  });
  it('rejects a reference that targets a foreign registry namespace', () => {
    const foreign = 'registry.fly.io/some-other-app:deployment-01ABC';
    expect(() => validateControllerImageBinding({ ...ok(), targetImageRef: foreign, resolvedImageRef: foreign, deployImageRef: foreign })).toThrow(ControllerImageBindingError);
    expect(() => validateControllerImageBinding({ ...ok(), expectedRegistryNamespace: 'registry.fly.io/king-ai-ops-hub-prod' })).toThrow(ControllerImageBindingError);
  });
  it('imageRepositoryNamespace strips tag and digest', () => {
    expect(imageRepositoryNamespace(`${NS}:tag`)).toBe(NS);
    expect(imageRepositoryNamespace(`${NS}@${DIGEST}`)).toBe(NS);
    expect(imageRepositoryNamespace(`${NS}:tag@${DIGEST}`)).toBe(NS);
    expect(imageRepositoryNamespace(NS)).toBe(NS);
  });
});
