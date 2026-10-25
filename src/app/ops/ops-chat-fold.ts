/**
 * Ops Chat — fold the busy parts of a reply (owner request 2026-10-25, part 3 of the layout work):
 *  - the tools a reply used become ONE line ("Steps: searching the web ×2 · listing tasks"), expandable, the way the
 *    Claude app shows "Ran 3 commands ›";
 *  - a long answer shows its first part with "Show full answer", so one reply never fills the screen.
 * Pure; no IO.
 */

/** A reply longer than this (characters) starts collapsed once it has finished streaming. */
export const LONG_REPLY_CHARS = 2_500;

export interface ReplyStep {
  /** Tool name as streamed (e.g. "web_search"). */
  name: string;
}

export interface StepGroup {
  label: string;
  count: number;
}

/** Steps grouped by tool in first-use order, with a readable label. Unknown tools read "looking that up". */
export function summarizeSteps(steps: readonly ReplyStep[], labels: Readonly<Record<string, string>>): StepGroup[] {
  const groups = new Map<string, StepGroup>();
  for (const s of steps) {
    const label = labels[s.name] ?? 'looking that up';
    const g = groups.get(label);
    if (g) g.count += 1;
    else groups.set(label, { label, count: 1 });
  }
  return [...groups.values()];
}

/** The one-line summary: "3 steps: searching the web ×2 · listing tasks". Empty when no tool ran. */
export function stepsLine(steps: readonly ReplyStep[], labels: Readonly<Record<string, string>>): string {
  if (steps.length === 0) return '';
  const parts = summarizeSteps(steps, labels).map((g) => (g.count > 1 ? `${g.label} ×${g.count}` : g.label));
  return `${steps.length} step${steps.length === 1 ? '' : 's'}: ${parts.join(' · ')}`;
}

/** Whether a finished reply should start collapsed. Never while it is still streaming. */
export function startsCollapsed(text: string, streaming: boolean): boolean {
  return !streaming && text.length > LONG_REPLY_CHARS;
}
