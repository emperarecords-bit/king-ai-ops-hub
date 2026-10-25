import { resolveQuestionFromInbox, type QuestionAnswerState } from './actions';

const INITIAL: QuestionAnswerState = { error: null, resolved: false };

export interface ResolveManyResult {
  /** How many questions were resolved (from `startAt`, counted cumulatively). */
  readonly resolved: number;
  readonly error: string | null;
}

/**
 * Resolve several owner questions with ONE answer (or dismiss them) through the SAME governed path
 * as the single-question form: `resolveQuestionFromInbox` is called once per id, sequentially. No
 * batch write type exists; each call re-derives tenancy and admin authority and records its own
 * knowledge + audit entry. Stops at the first failure so the owner sees exactly how far it got.
 */
export async function resolveMany(
  projectKey: string,
  questionIds: readonly string[],
  intent: 'answer' | 'dismiss',
  answer: string,
  startAt: number,
  onProgress: (resolved: number) => void,
): Promise<ResolveManyResult> {
  let resolved = startAt;
  for (const questionId of questionIds.slice(startAt)) {
    const fd = new FormData();
    fd.set('projectKey', projectKey);
    fd.set('questionId', questionId);
    fd.set('intent', intent);
    if (intent === 'answer') fd.set('answer', answer);
    const res = await resolveQuestionFromInbox(INITIAL, fd);
    if (!res.resolved) return { resolved, error: res.error ?? 'Something went wrong.' };
    resolved += 1;
    onProgress(resolved);
  }
  return { resolved, error: null };
}
