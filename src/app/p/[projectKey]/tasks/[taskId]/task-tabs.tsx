import Link from 'next/link';

/**
 * Task page tabs (Hub owner feedback 2026-10-22: "confusing… jumbled"). One answer per page: the Answer tab shows
 * the result once; the Review tab says what the review actually was; How it was made holds the steps, context,
 * prompt identity and the raw conversation. Plain links (`?tab=`), so it works without client JS and each tab
 * is linkable.
 */
export const TASK_TABS = ['answer', 'review', 'how'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

const TAB_LABEL: Record<TaskTab, string> = {
  answer: 'Answer',
  review: 'Review',
  how: 'How it was made',
};

export function parseTaskTab(value: string | undefined): TaskTab {
  return (TASK_TABS as readonly string[]).includes(value ?? '') ? (value as TaskTab) : 'answer';
}

export function taskTabHref(basePath: string, tab: TaskTab): string {
  return tab === 'answer' ? basePath : `${basePath}?tab=${tab}`;
}

export function TaskTabNav({ basePath, active, reviewNote }: { basePath: string; active: TaskTab; reviewNote?: string | null }) {
  return (
    <nav aria-label="Task sections" className="mb-6 flex flex-wrap gap-1 border-b border-[var(--border)]">
      {TASK_TABS.map((tab) => {
        const current = tab === active;
        return (
          <Link
            key={tab}
            href={taskTabHref(basePath, tab)}
            aria-current={current ? 'page' : undefined}
            data-testid={`task-tab-${tab}`}
            className={`-mb-px rounded-t px-4 py-2 text-sm ${
              current
                ? 'border border-b-[var(--background)] border-[var(--border)] bg-[var(--background)] font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            {TAB_LABEL[tab]}
            {tab === 'review' && reviewNote ? <span className="ml-2 text-xs text-[var(--muted)]">· {reviewNote}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
