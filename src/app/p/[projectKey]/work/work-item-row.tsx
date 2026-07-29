'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { finishWorkItemAction, stopWorkItemAction, updateWorkItemAction, type WorkItemState } from './actions';
import { OwnerPicker, type OwnerOption } from '../owner-picker';
import { ClassificationChip } from '../non-live-controls';
import { type WorkItemCondition, type DataClassification } from '@/types/domain';

const inputCls =
  'w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm';
const labelCls = 'block text-xs text-[var(--muted)] mb-1';

const CONDITION_LABEL: Record<WorkItemCondition, string> = {
  planned: 'Planned',
  moving: 'Moving',
  waiting: 'Waiting',
  finished: 'Finished',
  stopped: 'Stopped',
};

export interface WorkItemView {
  id: string;
  title: string;
  /** null = never established → "Unknown", pending review. */
  condition: WorkItemCondition | null;
  waitingOn: string | null;
  stage: string;
  notes: string;
  ownerAgentId: string | null;
  ownerName: string | null;
  objectiveTitle: string | null;
}

/**
 * One work item: header line (title · stage · objective · owner) plus an
 * "Edit" disclosure that reveals the in-place title/stage/notes form. Editable
 * is the whole reason this object exists — unlike a write-once task.
 */
export function WorkItemRow({
  projectKey,
  item,
  employees,
  canEdit,
  classification,
}: {
  projectKey: string;
  item: WorkItemView;
  employees: OwnerOption[];
  canEdit: boolean;
  classification: DataClassification;
}) {
  const [state, action, pending] = useActionState<WorkItemState, FormData>(updateWorkItemAction, {
    error: null,
  });
  const [fState, fAction, fPending] = useActionState<WorkItemState, FormData>(finishWorkItemAction, { error: null });
  const [sState, sAction] = useActionState<WorkItemState, FormData>(stopWorkItemAction, { error: null });

  return (
    <li className="border-b border-[var(--border)] py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <ClassificationChip classification={classification} />
        <Link href={`/p/${projectKey}/work/${item.id}`} className="text-sm font-medium hover:text-[var(--accent)]">
          {item.title}
        </Link>
        <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--foreground)]">
          {item.condition ? CONDITION_LABEL[item.condition] : 'Unknown'}
        </span>
        {item.condition === null ? (
          <span className="text-xs text-[var(--danger)]">needs review</span>
        ) : null}
        {item.condition === 'waiting' && item.waitingOn ? (
          <span className="text-xs text-[var(--muted)]">on {item.waitingOn}</span>
        ) : null}
        {item.stage && item.stage !== 'New' ? (
          <span className="text-xs text-[var(--muted)]">· {item.stage}</span>
        ) : null}
        {item.objectiveTitle ? (
          <span className="text-xs text-[var(--muted)]">· {item.objectiveTitle}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
          Owner:
          {canEdit ? (
            <OwnerPicker
              projectKey={projectKey}
              object="work_item"
              objectId={item.id}
              ownerAgentId={item.ownerAgentId}
              employees={employees}
              revalidate={`/p/${projectKey}/work`}
            />
          ) : (
            <span>{item.ownerName ?? 'Unassigned'}</span>
          )}
        </span>
      </div>

      {item.notes ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--muted)]">{item.notes}</p>
      ) : null}

      {canEdit ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
            Edit
          </summary>
          <form action={action} className="mt-3 space-y-3">
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="workItemId" value={item.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Title</label>
                <input name="title" required maxLength={200} defaultValue={item.title} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Condition</label>
                <select name="condition" defaultValue={item.condition ?? 'planned'} className={inputCls}>
                  <option value="planned">Planned</option>
                  <option value="moving">Moving</option>
                  <option value="waiting">Waiting</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Waiting on (if waiting)</label>
                <input name="waitingOn" maxLength={200} defaultValue={item.waitingOn ?? ''} className={inputCls} placeholder="e.g. customer reply" />
              </div>
              <div>
                <label className={labelCls}>Stage (your label)</label>
                <input name="stage" maxLength={60} defaultValue={item.stage} className={inputCls} list="work-stages" />
              </div>
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <textarea name="notes" rows={4} maxLength={8000} defaultValue={item.notes} className={inputCls} />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={pending} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast,#111)] disabled:opacity-60">
                {pending ? 'Saving…' : 'Save'}
              </button>
              {state.error ? <span className="text-sm text-[var(--danger)]">{state.error}</span> : null}
            </div>
          </form>

          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <p className="mb-2 text-xs text-[var(--muted)]">Close this work — the record is frozen afterward.</p>
            <div className="flex flex-wrap items-start gap-3">
              <form action={fAction}>
                <input type="hidden" name="projectKey" value={projectKey} />
                <input type="hidden" name="workItemId" value={item.id} />
                <button type="submit" disabled={fPending} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:border-[var(--success)] disabled:opacity-60">
                  Mark finished
                </button>
              </form>
              <form action={sAction} className="flex flex-col gap-2">
                <input type="hidden" name="projectKey" value={projectKey} />
                <input type="hidden" name="workItemId" value={item.id} />
                <textarea name="reason" required rows={2} placeholder="Why is this being stopped? (required — becomes the record)" className={inputCls} />
                <button type="submit" className="self-start rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:border-[var(--danger)]">
                  Stop
                </button>
              </form>
            </div>
            {fState.error ? <p className="mt-2 text-sm text-[var(--danger)]">{fState.error}</p> : null}
            {sState.error ? <p className="mt-2 text-sm text-[var(--danger)]">{sState.error}</p> : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}
