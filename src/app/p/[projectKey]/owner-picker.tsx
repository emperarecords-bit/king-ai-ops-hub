'use client';

import { useActionState, useRef } from 'react';
import { setOwnerAction, type OwnerState } from './owner-actions';

export interface OwnerOption {
  id: string;
  name: string;
  title: string | null;
}

/**
 * Owner selector for a business object (Slice 1, Stage 4). Submits on change;
 * "Unassigned" clears the owner. Descriptive only — no routing follows.
 */
export function OwnerPicker({
  projectKey,
  object,
  objectId,
  ownerAgentId,
  employees,
  revalidate,
}: {
  projectKey: string;
  object: 'task' | 'decision' | 'objective' | 'project';
  objectId: string;
  ownerAgentId: string | null;
  employees: OwnerOption[];
  revalidate?: string;
}) {
  const [state, action, pending] = useActionState<OwnerState, FormData>(setOwnerAction, { error: null });
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="object" value={object} />
      <input type="hidden" name="objectId" value={objectId} />
      {revalidate ? <input type="hidden" name="revalidate" value={revalidate} /> : null}
      <select
        name="ownerAgentId"
        defaultValue={ownerAgentId ?? ''}
        disabled={pending}
        onChange={() => formRef.current?.requestSubmit()}
        className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
        aria-label="Owner"
      >
        <option value="">Unassigned</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
            {e.title ? ` · ${e.title}` : ''}
          </option>
        ))}
      </select>
      {pending ? <span className="text-xs text-[var(--muted)]">Saving…</span> : null}
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
