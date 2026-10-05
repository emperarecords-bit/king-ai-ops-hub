/**
 * Voice-line security primitives — the fail-closed gates the phone/SMS surface relies on,
 * extracted as pure functions so they can be unit-tested offline (no Twilio, no network, no
 * secrets, no running server). `server.js` uses exactly these, so the tests cover the real
 * code paths. The only dependency is Node's built-in `crypto`.
 */
const crypto = require('crypto');

/** Parse the OWNER_PHONE_NUMBERS env (comma-separated E.164) into a clean array. */
function parseOwnerNumbers(env) {
  return String(env || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Caller-ID allowlist. FAIL-CLOSED: an empty/unknown allowlist allows NO ONE, so an
 * unconfigured deployment refuses every caller rather than defaulting open.
 */
function isAllowedCaller(ownerNumbers, from) {
  return Array.isArray(ownerNumbers) && ownerNumbers.length > 0 && ownerNumbers.includes(from);
}

/**
 * Constant-time PIN check over the expected PIN's length. FAIL-CLOSED: an empty/unset expected
 * PIN never matches (so a deployment without VOICE_PIN cannot be entered). Timing-safe so a
 * wrong PIN leaks no length/prefix information.
 */
function pinMatches(expectedPin, digits) {
  const pin = String(expectedPin || '');
  if (pin.length === 0) return false;
  const got = String(digits == null ? '' : digits);
  // Require an exact-length match: a shorter or longer input is rejected outright, so an
  // over-long entry whose first digits happen to match the PIN can never pass. (The Twilio
  // gather caps collection at the PIN length, so the legit path always hits this equal-length
  // compare.) The equal-length branch is constant-time.
  if (got.length !== pin.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(pin));
  } catch {
    return false;
  }
}

/**
 * Twilio webhook signature gate. FAIL-CLOSED: with no auth token configured it returns false
 * (every webhook is rejected) rather than skipping validation. Otherwise it delegates to the
 * Twilio validator; `validate` is injectable so this is testable without the Twilio SDK.
 */
function isValidTwilioSignature(authToken, signature, url, params, validate) {
  if (!authToken) return false;
  const v = validate || require('twilio').validateRequest;
  return Boolean(v(authToken, signature, url, params || {}));
}

/** Collapse whitespace, trim, and hard-cap length — for speakable/textable summaries. */
function short(s, n) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/**
 * Advance the inbox-notifier watermark to 1ms PAST the newest row. Postgres timestamps carry
 * microseconds but JS Dates only milliseconds, so a watermark left AT a row's ms would re-match
 * that row every poll (the "emailing every minute" storm). Returns a new Date; never moves back.
 */
function nextWatermark(rows, watermark) {
  let wm = watermark instanceof Date ? watermark.getTime() : Number(watermark) || 0;
  for (const r of rows || []) {
    const ts = new Date(r.created_at).getTime() + 1;
    if (ts > wm) wm = ts;
  }
  return new Date(wm);
}

/** Stable dedupe key for a notifier row — the second defense against re-notifying the same item. */
function dedupeKey(r) {
  return `${r.kind}|${r.key}|${r.item}`;
}

module.exports = {
  parseOwnerNumbers,
  isAllowedCaller,
  pinMatches,
  isValidTwilioSignature,
  short,
  nextWatermark,
  dedupeKey,
};
