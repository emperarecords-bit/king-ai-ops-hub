/**
 * Context freshness signals (O-17). A separate axis from authority (which
 * source controls), injection-trust (whether content may issue commands), and
 * relevance (retrieval rank). Freshness only describes HOW CURRENT the evidence
 * behind a context item appears to be, so the model can explain *why* the
 * authoritative source is (or isn't) demonstrably newer than a conflicting one.
 *
 * Pure and deterministic: no DB, no clock reads inside the parser. All dates in
 * are provided by the caller; the parser reads only explicit, labeled patterns.
 */

import {
  type Freshness,
  type FreshnessComparison,
  type FreshnessRelation,
} from '@/types/domain';

export { type Freshness, type FreshnessComparison, type FreshnessRelation };

/**
 * Conservative explicit-date parser. Recognizes ONLY labeled patterns — never
 * a bare year in prose, a file mtime, or the run clock. Returns an ISO date
 * (YYYY-MM-DD) or null. First match wins, scanning label patterns in order.
 *
 * Accepted, case-insensitive, label + date on the same line:
 *   "Status as of July 23, 2026"      "as of 2026-07-23"
 *   "Last updated: 2026-07-23"        "Updated: 07/23/2026"
 *   "Effective date: 07/23/2026"      "Effective: July 23 2026"
 *   "Date: 2026-07-23"
 */
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

// The label that must precede the date for us to trust it as an effective date.
const LABEL = '(?:status\\s+as\\s+of|as\\s+of|last\\s+updated|updated|effective\\s+date|effective|date)';
// Three explicit date shapes.
const ISO = '(\\d{4})-(\\d{2})-(\\d{2})'; // 2026-07-23
const US = '(\\d{1,2})/(\\d{1,2})/(\\d{4})'; // 07/23/2026
const LONG = '([A-Za-z]+)\\s+(\\d{1,2}),?\\s+(\\d{4})'; // July 23, 2026

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseEffectiveDate(text: string): string | null {
  if (!text) return null;
  // Only inspect the head of the document — an effective-date label lives in a
  // header, not buried in narrative, and this bounds the scan.
  const head = text.slice(0, 2000);

  const isoRe = new RegExp(`${LABEL}\\s*:?\\s*${ISO}`, 'i');
  const usRe = new RegExp(`${LABEL}\\s*:?\\s*${US}`, 'i');
  const longRe = new RegExp(`${LABEL}\\s*:?\\s*${LONG}`, 'i');

  const mIso = head.match(isoRe);
  if (mIso) return iso(Number(mIso[1]), Number(mIso[2]), Number(mIso[3]));

  const mUs = head.match(usRe);
  if (mUs) return iso(Number(mUs[3]), Number(mUs[1]), Number(mUs[2]));

  const mLong = head.match(longRe);
  if (mLong) {
    const month = MONTHS[mLong[1]!.toLowerCase()];
    if (month) return iso(Number(mLong[3]), month, Number(mLong[2]));
  }
  return null;
}

/** The best comparable instant for a side of a conflict: effective date wins
 *  over source-update time (an explicit "as of" beats a file mtime). */
function comparableInstant(f: Freshness | null | undefined): string | null {
  if (!f) return null;
  return f.contentEffectiveAt ?? f.sourceUpdatedAt ?? null;
}

/**
 * Precomputes the freshness relationship between the authoritative Hub side and
 * a conflicting document side. Compares by calendar day (dates, not times) so a
 * document's day-granular effective date lines up with a Hub timestamp.
 * "not_comparable" whenever either side lacks a usable date — never guessed.
 */
export function compareFreshness(
  hub: Freshness | null | undefined,
  doc: Freshness | null | undefined,
): FreshnessComparison {
  const h = comparableInstant(hub);
  const d = comparableInstant(doc);
  if (!h || !d) {
    return {
      relation: 'not_comparable',
      explanation:
        'Freshness cannot be directly compared: ' +
        (!h && !d ? 'neither side has a usable date.' : !h ? 'the Hub side has no usable date.' : 'the document has no reliably parsed effective date.'),
      hubInstant: h,
      documentInstant: d,
    };
  }
  const hd = h.slice(0, 10);
  const dd = d.slice(0, 10);
  if (hd === dd) {
    return { relation: 'same_date', explanation: `Both sides are dated ${hd}.`, hubInstant: h, documentInstant: d };
  }
  if (hd > dd) {
    return {
      relation: 'hub_newer',
      explanation: `The Hub record (${hd}) is newer than the document (${dd}).`,
      hubInstant: h,
      documentInstant: d,
    };
  }
  return {
    relation: 'document_newer',
    explanation: `The document (${dd}) appears newer than the Hub record (${hd}).`,
    hubInstant: h,
    documentInstant: d,
  };
}
