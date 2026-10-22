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
 */

export const MIN_ITEMS = 2;
export const MAX_ITEMS = 12;
export const STEM_CHARS = 5;
const MIN_WORD = 4;
const STOP = new Set([
  'with', 'from', 'that', 'this', 'each', 'over', 'into', 'onto', 'also', 'both', 'than', 'then', 'they', 'them', 'their',
  'what', 'when', 'where', 'which', 'will', 'your', 'about', 'other', 'items', 'item', 'list', 'make', 'sure', 'more',
  'some', 'such', 'only', 'have', 'been', 'were', 'does', 'done', 'given', 'based', 'clean', 'formal', 'final', 'updated',
]);

export interface Deliverable {
  /** The heading as written in the brief, e.g. "Vendor-ready material list". */
  heading: string;
  /** Lower-case stems that must each appear in the result, e.g. ["vendo", "ready", "mater"]. */
  stems: string[];
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
    const stems = [
      ...new Set(
        heading
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= MIN_WORD && !STOP.has(w) && !/^\d+$/.test(w))
          .map((w) => w.slice(0, STEM_CHARS)),
      ),
    ];
    if (!heading || stems.length === 0 || seen.has(heading.toLowerCase())) continue;
    seen.add(heading.toLowerCase());
    out.push({ heading, stems });
    if (out.length >= MAX_ITEMS) break;
  }
  return out.length >= MIN_ITEMS ? out : [];
}

/** Every distinct stem the deliverables need (for one SQL position check per stem). */
export function allStems(ds: readonly Deliverable[]): string[] {
  return [...new Set(ds.flatMap((d) => d.stems))];
}

/** Headings with at least one stem the result lacks, given which stems were found. */
export function notFoundHeadings(ds: readonly Deliverable[], found: ReadonlySet<string>): string[] {
  return ds.filter((d) => d.stems.some((s) => !found.has(s))).map((d) => d.heading);
}

/** In-memory check (the caller already holds the result). Empty when there is nothing to check or all are present. */
export function deliverablesNotFound(input: string, result: string | null | undefined): string[] {
  const ds = briefDeliverables(input);
  if (ds.length === 0 || !result) return [];
  const lower = result.toLowerCase();
  return notFoundHeadings(ds, new Set(allStems(ds).filter((s) => lower.includes(s))));
}

/** The owner-facing sentence, or '' when nothing is missing. */
export function notFoundSentence(headings: readonly string[]): string {
  if (headings.length === 0) return '';
  return ` Not found in the result: ${headings.map((h) => `"${h}"`).join(', ')} — it may be incomplete; check before relying on it.`;
}
