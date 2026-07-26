'use client';

import { useActionState } from 'react';
import { createEmployeeAction, saveEmployeeOrgAction, type AgentFormState } from './actions';

const inputCls =
  'w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm';
const labelCls = 'block text-xs text-[var(--muted)] mb-1';

export interface EmployeeLite {
  id: string;
  name: string;
  title: string | null;
  departmentId: string | null;
  reportsToId: string | null;
  enabled: boolean;
}

/**
 * Employee org fields (Slice 1). Create a new employee, or edit an existing
 * one's name / title / department / manager / status. Descriptive only — no
 * routing follows from any of this.
 */
export function EmployeeOrgForm({
  projectKey,
  mode,
  employee,
  departments,
  employees,
}: {
  projectKey: string;
  mode: 'create' | 'edit';
  employee?: EmployeeLite;
  departments: { id: string; name: string }[];
  employees: { id: string; name: string }[];
}) {
  const initial: AgentFormState = { error: null, saved: false };
  const action = mode === 'create' ? createEmployeeAction : saveEmployeeOrgAction;
  const [state, formAction, pending] = useActionState(action, initial);
  // A manager can be anyone except this employee.
  const managerOptions = employees.filter((e) => e.id !== employee?.id);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      {mode === 'edit' ? <input type="hidden" name="employeeId" value={employee!.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Name</label>
          <input name="name" required maxLength={120} defaultValue={employee?.name ?? ''} className={inputCls} placeholder="Jane Smith" />
        </div>
        <div>
          <label className={labelCls}>Role / title</label>
          <input name="title" maxLength={120} defaultValue={employee?.title ?? ''} className={inputCls} placeholder="e.g. CMO, Sales Manager" />
        </div>
        <div>
          <label className={labelCls}>Department</label>
          <select name="departmentId" defaultValue={employee?.departmentId ?? ''} className={inputCls}>
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Reports to (manager)</label>
          <select name="reportsToId" defaultValue={employee?.reportsToId ?? ''} className={inputCls}>
            <option value="">— Nobody —</option>
            {managerOptions.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      </div>

      {mode === 'create' ? <input type="hidden" name="role" value="primary" /> : (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={employee?.enabled ?? true} />
          Active (unchecked = on leave / disabled)
        </label>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast,#111)] disabled:opacity-60">
          {pending ? 'Saving…' : mode === 'create' ? 'Add employee' : 'Save'}
        </button>
        {state.error ? <span className="text-sm text-[var(--danger)]">{state.error}</span> : null}
        {state.saved ? <span className="text-sm text-[var(--muted)]">Saved.</span> : null}
      </div>
    </form>
  );
}
