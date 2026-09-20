/**
 * Review-package export (Priority 4).
 *
 * Assembles the ACTUAL selected files plus a manifest (source paths, sha256,
 * source commit, omissions, verification status). Before anything is included it:
 *  - excludes credentials, customer data, session artifacts, and Git history by
 *    path class, and
 *  - inspects each file's contents for sensitive values and omits any that carry one.
 *
 * `assertDeliverable` refuses to let a caller claim delivery of a file that was
 * omitted or never found — a missing artifact can never be reported as delivered.
 */
import { createHash } from 'node:crypto';
import { containsSensitive, isExcludedPath } from './sanitize';
import type { ManifestEntry, ManifestOmission, ReviewManifest, ReviewPackage, TaskVerificationStatus } from './types';

export interface SelectedFile {
  /** Path inside the package. */
  readonly path: string;
  /** Where it came from (repo-relative or absolute). */
  readonly sourcePath: string;
  /** File bytes, or null when the file could not be read (missing). */
  readonly bytes: Buffer | null;
}

export interface BuildPackageInput {
  readonly sourceCommit: string | null;
  readonly verificationStatus: TaskVerificationStatus;
  readonly selected: readonly SelectedFile[];
  readonly generatedAt?: string;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function buildReviewPackage(input: BuildPackageInput): ReviewPackage {
  const files: { path: string; bytes: Buffer }[] = [];
  const entries: ManifestEntry[] = [];
  const omissions: ManifestOmission[] = [];

  for (const f of input.selected) {
    const exSource = isExcludedPath(f.sourcePath);
    const ex = exSource.excluded ? exSource : isExcludedPath(f.path);
    if (ex.excluded) {
      omissions.push({ path: f.path, reason: 'excluded_class', detail: ex.reason });
      continue;
    }
    if (f.bytes === null) {
      omissions.push({ path: f.path, reason: 'not_found', detail: `Source not found: ${f.sourcePath}` });
      continue;
    }
    // Inspect contents for sensitive values BEFORE including.
    if (containsSensitive(f.bytes.toString('utf8'))) {
      omissions.push({ path: f.path, reason: 'contains_sensitive', detail: 'File contains a secret-shaped value.' });
      continue;
    }
    entries.push({ path: f.path, sourcePath: f.sourcePath, sha256: sha256(f.bytes), sizeBytes: f.bytes.length });
    files.push({ path: f.path, bytes: f.bytes });
  }

  const manifest: ReviewManifest = {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    verificationStatus: input.verificationStatus,
    files: entries,
    omissions,
    sensitiveScan: omissions.some((o) => o.reason === 'contains_sensitive') ? 'omitted' : 'clean',
  };

  return { manifest, files };
}

/**
 * Guard against a false delivery claim: throws if any promised path is not
 * present in the built package (it was excluded, sensitive, or missing).
 */
export function assertDeliverable(pkg: ReviewPackage, promisedPaths: readonly string[]): void {
  const have = new Set(pkg.manifest.files.map((f) => f.path));
  const absent = promisedPaths.filter((p) => !have.has(p));
  if (absent.length > 0) {
    const why = absent
      .map((p) => {
        const o = pkg.manifest.omissions.find((x) => x.path === p);
        return `${p} (${o ? `${o.reason}: ${o.detail}` : 'not selected'})`;
      })
      .join('; ');
    throw new Error(`Cannot claim delivery — promised file(s) not in package: ${why}`);
  }
}
