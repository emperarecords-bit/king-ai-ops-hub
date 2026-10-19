// Type-only: this module is also used by the Inbox client component, so it must not pull in the
// server-side questions module.
import type { OpenOwnerQuestion } from './questions';

/**
 * Owner-confirmed "these are the same" (daily-use follow-up to #160). The automatic grouping in
 * `grouping.ts` is deliberately strict — identical normalized text only — so it never merges the
 * bookkeeper's reworded repeats. This is the OWNER's alternative: the owner ticks the questions they
 * judge to be the same and resolves them with one answer (or one dismissal).
 *
 * Nothing is merged or stored: there is no group record and no batch write type. The selection is
 * only the list of ids the client then resolves ONE AT A TIME through the existing governed path
 * (`resolveQuestionFromInbox`), which re-derives tenancy + admin authority for every id. This module
 * is the pure guard on what may be selected together.
 */

/** A selection never spans workspaces, and "the same" needs at least two questions. */
export const MIN_SAME_SELECTION = 2;

export interface SameSelectionWorkspace {
  readonly projectKey: string;
  readonly workspaceName: string;
  /** This workspace's open questions, oldest first. */
  readonly questions: readonly OpenOwnerQuestion[];
}

/** Workspaces where the owner may mark questions as the same (two or more open questions), in Inbox order. */
export function sameSelectionWorkspaces(questions: readonly OpenOwnerQuestion[]): readonly SameSelectionWorkspace[] {
  const byProject = new Map<string, OpenOwnerQuestion[]>();
  for (const q of questions) {
    const list = byProject.get(q.projectKey);
    if (list) list.push(q);
    else byProject.set(q.projectKey, [q]);
  }
  const out: SameSelectionWorkspace[] = [];
  for (const [projectKey, list] of byProject) {
    if (list.length < MIN_SAME_SELECTION) continue;
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    out.push({ projectKey, workspaceName: sorted[0]!.workspaceName, questions: sorted });
  }
  out.sort((a, b) => a.questions[0]!.createdAt.getTime() - b.questions[0]!.createdAt.getTime());
  return out;
}

export type SameSelectionResult =
  | { readonly ok: true; readonly projectKey: string; readonly questionIds: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Validate an owner selection against the questions the Inbox actually offered for ONE workspace.
 * Fail-closed: unknown ids, ids from another workspace, or fewer than two distinct ids are rejected.
 * The returned ids are de-duplicated and ordered oldest first (the order they are resolved in).
 */
export function validateSameSelection(
  workspace: SameSelectionWorkspace,
  selectedIds: readonly string[],
): SameSelectionResult {
  const offered = new Map(workspace.questions.map((q) => [q.questionId, q]));
  const unique = [...new Set(selectedIds)];
  for (const id of unique) {
    const q = offered.get(id);
    if (!q) return { ok: false, error: 'A selected question is no longer open here. Reload the Inbox.' };
    if (q.projectKey !== workspace.projectKey) return { ok: false, error: 'A selection cannot span businesses.' };
  }
  if (unique.length < MIN_SAME_SELECTION) {
    return { ok: false, error: `Select at least ${MIN_SAME_SELECTION} questions that are the same.` };
  }
  const ordered = workspace.questions.filter((q) => unique.includes(q.questionId)).map((q) => q.questionId);
  return { ok: true, projectKey: workspace.projectKey, questionIds: ordered };
}
