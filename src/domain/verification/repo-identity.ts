/**
 * Canonical repository identity for verification (VER-002).
 *
 * GitHub `owner/repo` names are case-insensitive: `Acme/Widget` and `acme/widget` are the SAME
 * repository. Authorization already compares case-insensitively, so a single consistent identity
 * must be used everywhere else too — otherwise an identical retry with different capitalization is
 * authorized yet fails contract equality (a spurious conflict), and evidence with a differently
 * cased repo fails to bind. These helpers give creation, idempotent retries, and evidence binding
 * one shared notion of "same repository".
 */

/** Two repository names identify the same repository (case-insensitive, GitHub semantics). */
export function repoIdentityEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve a requested repository to its CANONICAL spelling — the exact casing recorded in the
 * project's trusted `github_repo_links`, which is the source of truth for how the repo is named.
 * The contract stores this canonical form so retries, reporting, and evidence binding all see one
 * stable identity. Falls back to the requested value when no trusted link matches (the caller
 * rejects that case separately as unauthorized).
 */
export function canonicalRepoIdentity(requested: string, linked: readonly string[]): string {
  return linked.find((l) => repoIdentityEquals(l, requested)) ?? requested;
}
