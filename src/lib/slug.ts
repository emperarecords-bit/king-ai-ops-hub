/**
 * Identifier slugs.
 *
 * `slugifyMetric` exists because the first real objective produced a metric
 * key of `number_of_project/workspace_integrations_connected_to_the_hub`
 * (O-11) — a naive whitespace replace leaves slashes, hyphens, and punctuation
 * in a field that is meant to be a stable machine identifier. The `metric`
 * field is what a future `source: "usage"` binding would join on, so it has to
 * be an identifier, not a sentence.
 */

const MAX_METRIC_LENGTH = 60;

/** `^[a-z][a-z0-9_]*$`, or 'metric' when the label yields nothing usable. */
export function slugifyMetric(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '') // strip accents
    .replaceAll(/[^a-z0-9]+/g, '_') // everything else becomes a separator
    .replaceAll(/_+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, MAX_METRIC_LENGTH)
    .replace(/_+$/, ''); // slicing can leave a trailing separator

  // Must start with a letter: a key like `100_beta_users` is a valid slug but
  // an invalid identifier in most systems that would consume it.
  if (slug.length === 0) return 'metric';
  return /^[a-z]/.test(slug) ? slug : `m_${slug}`.slice(0, MAX_METRIC_LENGTH);
}

export const METRIC_PATTERN = /^[a-z][a-z0-9_]*$/;
