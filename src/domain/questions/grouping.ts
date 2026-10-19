import { type OpenOwnerQuestion } from './questions';

/**
 * Inbox duplicate grouping (daily-use follow-up 2026-10): agents — the bookkeeper especially —
 * raise many near-identical owner-questions, so the Inbox filled with repeats. This is a
 * READ-TIME, display-only step over `openQuestionsForOwner` output: no schema, no new write
 * path. Each question is still answered/dismissed individually through the existing governed
 * path; a group only changes how they are shown.
 *
 * Grouping rule (deliberately strict — a group may be "answered all at once", so a false merge
 * is worse than a missed one):
 *   - same workspace (projectKey) — groups NEVER span workspaces/tenants;
 *   - same normalized text: Unicode NFKC, curly quotes/dashes unified, lowercased, whitespace
 *     collapsed, trimmed, trailing punctuation dropped, and UUIDs replaced by a placeholder
 *     (machine ids are noise, not meaning).
 * Dates, amounts and other numbers are KEPT: "the $1,200 charge" and "the $900 charge" are
 * different questions and must not share one answer.
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

export function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .toLowerCase()
    .replace(UUID_RE, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?.!,;:]+$/, '');
}

export interface OwnerQuestionGroup {
  /** Stable key: workspace + normalized text. */
  readonly groupKey: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  /** Display text: the NEWEST question's original wording. */
  readonly question: string;
  /** Always equals `questions.length`. */
  readonly count: number;
  readonly oldestAt: Date;
  readonly newestAt: Date;
  /** Distinct askers, in first-asked order. */
  readonly askedBy: readonly string[];
  /** The individual questions, oldest first — each still answered on its own id. */
  readonly questions: readonly OpenOwnerQuestion[];
}

/** Group open questions per workspace by normalized text. Groups are ordered oldest-first (the Inbox order). */
export function groupOpenQuestions(questions: readonly OpenOwnerQuestion[]): readonly OwnerQuestionGroup[] {
  const buckets = new Map<string, OpenOwnerQuestion[]>();
  for (const q of questions) {
    const key = `${q.projectKey}\u0000${normalizeQuestionText(q.question)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(q);
    else buckets.set(key, [q]);
  }
  const groups: OwnerQuestionGroup[] = [];
  for (const [groupKey, members] of buckets) {
    members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const oldest = members[0]!;
    const newest = members[members.length - 1]!;
    const askedBy: string[] = [];
    for (const m of members) if (m.askedBy && !askedBy.includes(m.askedBy)) askedBy.push(m.askedBy);
    groups.push({
      groupKey,
      projectKey: oldest.projectKey,
      workspaceName: oldest.workspaceName,
      question: newest.question,
      count: members.length,
      oldestAt: oldest.createdAt,
      newestAt: newest.createdAt,
      askedBy,
      questions: members,
    });
  }
  groups.sort((a, b) => a.oldestAt.getTime() - b.oldestAt.getTime());
  return groups;
}
