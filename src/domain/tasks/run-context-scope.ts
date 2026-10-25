/**
 * Run-context scope — how much of the workspace's OTHER live work a run may see.
 *
 * Evidence (server-cooling conversation, 2026-10-19): the owner's ad-hoc "Duct CFM calc" task ran with the
 * workspace's unrelated pending approvals ("Draft response to ONEAL …") and the AccurateBids Email Desk
 * (which instructs "draft a reply and propose it as an accuratebids_reply action") in its context. The agent
 * did the duct work AND re-proposed the ONEAL support reply, which parked the duct task behind an unrelated
 * approval. A run may only receive context that is relevant to its own task, objective, or standing schedule.
 *
 *  - 'standing'  — recurring standing work (tasks.schedule_id set): it owns the workspace's queues, so it sees
 *                  its own schedule's and objective's pending items and the Email Desk.
 *  - 'objective' — attached to an objective: sees that objective's pending items and the Email Desk.
 *  - 'focused'   — an ad-hoc owner task (e.g. dispatched from Ops Chat): sees NO other task's pending
 *                  approvals or awaiting-approval actions, and no actionable Email Desk entries.
 *
 * Pure (no DB) so the rule is unit-testable and shared by every context assembler.
 */
export type RunContextScope = 'standing' | 'objective' | 'focused';

export function runContextScope(task: { scheduleId: string | null; objectiveId: string | null }): RunContextScope {
  if (task.scheduleId) return 'standing';
  if (task.objectiveId) return 'objective';
  return 'focused';
}

/** Whether actionable AccurateBids Email Desk entries (ids, names, messages) may enter this run's context. */
export function includesEmailDesk(scope: RunContextScope): boolean {
  return scope !== 'focused';
}
