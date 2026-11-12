/**
 * Canonical JSON — the signing basis. MUST stay byte-identical to the Hub's
 * `src/domain/verification/signing.ts#canonicalJson`, or every signature this runner produces is
 * rejected as `bad_signature`.
 *
 * It is duplicated rather than imported ON PURPOSE: this package is a reference for an EXTERNAL
 * runner, which by definition cannot import Hub internals. The duplication is held honest by
 * `tests/unit/verification-runner-canonical.test.ts`, which imports BOTH implementations and
 * asserts identical output over a fixture corpus including the shapes that usually break
 * canonicalizers (nested objects, arrays of objects, unicode keys, nulls).
 *
 * Deliberately NOT a general canonicalizer: it is `JSON.stringify` over recursively key-sorted
 * values, matching the Hub exactly — same treatment of `undefined`, same number formatting, no NFC
 * normalization. Do not "improve" it here without changing the Hub in the same commit.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}
