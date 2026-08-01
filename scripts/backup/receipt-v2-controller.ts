/**
 * G-Backup-B1 — CONTROLLER-SIDE image-binding validation. Pure; fixtures only in B1. The external deployment
 * controller resolves the pushed image reference and its digest, and validates the reference→digest relationship
 * BEFORE publishing the receipt and BEFORE `fly deploy --image`. The digest is NOT independently re-resolved by the
 * release Machine (which cannot compute its own image digest); at runtime only `FLY_IMAGE_REF` is observable.
 */

export class ControllerImageBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllerImageBindingError';
  }
}

export interface ControllerImageBindingInput {
  /** The reference to be signed into the receipt. */
  readonly targetImageRef: string;
  /** The digest to be signed into the receipt. */
  readonly targetImageDigest: string;
  /** The reference the controller resolved for the pushed image. */
  readonly resolvedImageRef: string;
  /** The digest the controller resolved for the pushed image (independently, e.g. from the push/registry). */
  readonly resolvedImageDigest: string;
  /** The exact reference that will be handed to `fly deploy --image`. */
  readonly deployImageRef: string;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Validate the reference→digest binding controller-side. Throws {@link ControllerImageBindingError} (fail-closed)
 * BEFORE publication/deploy on any mismatch. Returns the validated pair.
 */
export function validateControllerImageBinding(input: ControllerImageBindingInput): { readonly targetImageRef: string; readonly targetImageDigest: string } {
  if (!DIGEST_RE.test(input.targetImageDigest)) throw new ControllerImageBindingError('targetImageDigest is not a valid sha256 digest');
  if (!DIGEST_RE.test(input.resolvedImageDigest)) throw new ControllerImageBindingError('resolvedImageDigest is not a valid sha256 digest');
  if (input.targetImageRef !== input.resolvedImageRef) throw new ControllerImageBindingError('targetImageRef does not equal the resolved image reference');
  if (input.targetImageRef !== input.deployImageRef) throw new ControllerImageBindingError('targetImageRef does not equal the exact deploy image reference');
  if (input.targetImageDigest !== input.resolvedImageDigest) throw new ControllerImageBindingError('targetImageDigest does not equal the resolved image digest');
  return { targetImageRef: input.targetImageRef, targetImageDigest: input.targetImageDigest };
}
