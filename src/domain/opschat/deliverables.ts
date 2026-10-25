/**
 * "Finished" is not "complete": which of the brief's NUMBERED deliverables a result does not mention.
 *
 * Evidence (Hub prod, server-cooling, read-only 2026-10-22): update run 2db706f8 finished in seconds and Ops Chat
 * reported it finished, but its 1,113-char punch list had no CFM / duct-sizing calculation (the owner had asked for
 * "the actual CFM … and 2-3 duct size options"), no vendor-ready material list (item 6 of the brief) and nothing on
 * the open items (item 5). Nothing told the owner.
 *
 * Deliberately CONSERVATIVE and honest about what it is: a word check, not a judgment of quality. It only looks at a
 * top-level numbered list in the brief ("1. Clearances — …"), takes each item's heading (text before " — ", ":" or
 * "."), and reports a heading when one of its key words does not appear in the result at all (matched on the first
 * STEM_CHARS letters, so "Controls" covers "Control", "Sequencing" covers "sequencing"). Fewer than MIN_ITEMS
 * numbered items → no check. The owner-facing wording is "not found in the result", never "incomplete" as a fact.
 * Pure: no IO. Result text is read by the caller (SQL position checks, or in memory where it is already loaded).
 *
 * Hub prod 2026-10-24 (run b7e7522e, read-only): a COMPLETE result — its own sections "3. CFM Calculation & Duct Sizing
 * Options", "7. Vendor Material List", "8. Open Items" — was reported "not found" for all three, because requiring
 * EVERY word of an item failed on incidental ones from its parenthetical detail ("capacity", "component") or phrasing
 * ("unresolved", "needing"). So an item now counts as present when EITHER
 *   - a section heading of the result (markdown "#…" or a whole-line **bold**) contains the LAST of its MAIN words
 *     (the heading text before any "(" or ",", e.g. "CFM calculation with 2–3 sizing options") and at least half of
 *     them; or
 *   - the body contains all its main words AND at least BODY_SHARE of all its words.
 * Still a word check, still conservative: a result missing an item's main words is still reported.
 */

export const MIN_ITEMS = 2;
export const MAX_ITEMS = 12;
export const STEM_CHARS = 5;
const MIN_WORD = 4;
/** Share of an item's words the body must contain (with all its main words) when no result heading matches. */
export const BODY_SHARE = 0.75;
const STOP = new Set([
  'with', 'from', 'that', 'this', 'each', 'over', 'into', 'onto', 'also', 'both', 'than', 'then', 'they', 'them', 'their',
  'what', 'when', 'where', 'which', 'will', 'your', 'about', 'other', 'items', 'item', 'list', 'make', 'sure', 'more',
  'some', 'such', 'only', 'have', 'been', 'were', 'does', 'done', 'given', 'based', 'clean', 'formal', 'final', 'updated',
]);

export interface Deliverable {
  /** The heading as written in the brief, e.g. "Vendor-ready material list". */
  heading: string;
  /** Lower-case stems of the whole heading, e.g. ["vendo", "ready", "mater"]. */
  stems: string[];
  /** Stems of the heading's main part (before any "(" or ","): the words the result must carry. */
  mainStems: string[];
}

function stemsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= MIN_WORD && !STOP.has(w) && !/^\d+$/.test(w))
        .map((w) => w.slice(0, STEM_CHARS)),
    ),
  ];
}

/** The part of a brief that holds the task's own instructions (an update card's ORIGINAL INSTRUCTIONS section). */
function instructionsPart(input: string): string {
  const m = /=== ORIGINAL INSTRUCTIONS ===\n([\s\S]*?)(?:\n=== |$)/.exec(input);
  return m ? m[1]! : input;
}

/** Numbered deliverables of a brief, in order. Empty when the brief has fewer than MIN_ITEMS numbered items. */
export function briefDeliverables(input: string): Deliverable[] {
  const text = instructionsPart(input.replace(/\r\n?/g, '\n'));
  const out: Deliverable[] = [];
  const seen = new Set<string>();
  // "1. Heading — detail" / "2) Heading: detail" at the start of a line, or inline after ". " (briefs written as one
  // paragraph, e.g. "Cover: / 1. Clearances — … / 2. Structural — …").
  const re = /(?:^|\n|\s)(\d{1,2})[.)]\s+([^\n]+?)(?=\s(?:\d{1,2})[.)]\s|\n|$)/g;
  let expect = 1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = Number(m[1]);
    if (n !== expect) continue; // only a clean 1, 2, 3 … sequence counts as the deliverable list
    expect++;
    const heading = m[2]!.split(/\s[—–-]\s|:|\.\s|\.$/)[0]!.replace(/\*\*/g, '').trim().slice(0, 80);
    const stems = stemsOf(heading);
    if (!heading || stems.length === 0 || seen.has(heading.toLowerCase())) continue;
    seen.add(heading.toLowerCase());
    const main = stemsOf(heading.split(/[(,]/)[0]!);
    out.push({ heading, stems, mainStems: main.length > 0 ? main : stems });
    if (out.length >= MAX_ITEMS) break;
  }
  return out.length >= MIN_ITEMS ? out : [];
}

/** Every distinct stem the deliverables need (for one SQL position check per stem). */
export function allStems(ds: readonly Deliverable[]): string[] {
  return [...new Set(ds.flatMap((d) => d.stems))];
}

/**
 * The result's section headings: markdown "#…" lines and whole-line **bold** lines, each at most 200 chars. The SQL
 * path extracts the same lines with RESULT_HEADING_SQL_PATTERN, so both paths judge identically.
 */
export function resultHeadings(result: string): string[] {
  const out: string[] = [];
  for (const m of result.matchAll(/^(#{1,6} [^\r\n]{1,200}|\*\*[^\r\n]{1,200}\*\*)\r?$/gm)) out.push(m[1]!);
  return out;
}

/** Postgres ARE for `regexp_matches(result, pattern, 'gn')` — the same lines as resultHeadings. */
export const RESULT_HEADING_SQL_PATTERN = '^(#{1,6} [^\\r\\n]{1,200}|\\*\\*[^\\r\\n]{1,200}\\*\\*)\\r?$';

/**
 * Headings of the brief the result does not cover, given which stems appear anywhere in the result (`found`) and
 * the result's own section headings. The rule is at the top of this file.
 */
export function notFoundHeadings(ds: readonly Deliverable[], found: ReadonlySet<string>, headings: readonly string[] = []): string[] {
  const lowerHeadings = headings.map((h) => h.toLowerCase());
  const covered = (d: Deliverable): boolean => {
    // A heading names the item when it has the item's LAST main word (the core noun of an English noun phrase:
    // "sizing", "open", "material") and at least half of its main words — so "Open Items" covers "A clear open-items
    // list", while "Shared Ductwork" does not cover "Ductwork sizing".
    const last = d.mainStems[d.mainStems.length - 1]!;
    const half = Math.ceil(d.mainStems.length / 2);
    if (lowerHeadings.some((h) => h.includes(last) && d.mainStems.filter((s) => h.includes(s)).length >= half)) return true;
    if (!d.mainStems.every((s) => found.has(s))) return false;
    return d.stems.filter((s) => found.has(s)).length >= Math.ceil(d.stems.length * BODY_SHARE);
  };
  return ds.filter((d) => !covered(d)).map((d) => d.heading);
}

/** In-memory check (the caller already holds the result). Empty when there is nothing to check or all are present. */
export function deliverablesNotFound(input: string, result: string | null | undefined): string[] {
  const ds = briefDeliverables(input);
  if (ds.length === 0 || !result) return [];
  const lower = result.toLowerCase();
  return notFoundHeadings(ds, new Set(allStems(ds).filter((s) => lower.includes(s))), resultHeadings(result));
}

/** The owner-facing sentence, or '' when nothing is missing. */
export function notFoundSentence(headings: readonly string[]): string {
  if (headings.length === 0) return '';
  return ` Not found in the result: ${headings.map((h) => `"${h}"`).join(', ')} — it may be incomplete; check before relying on it.`;
}
