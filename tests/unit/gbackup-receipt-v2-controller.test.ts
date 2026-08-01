import { describe, expect, it } from 'vitest';
import { ControllerImageBindingError, validateControllerImageBinding } from '../../scripts/backup/receipt-v2-controller';

const REF = 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ok = () => ({ targetImageRef: REF, targetImageDigest: DIGEST, resolvedImageRef: REF, resolvedImageDigest: DIGEST, deployImageRef: REF });

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
});
