/**
 * Hub prod 2026-10-25: switching Principal Reviewer to GPT-5.4 SAVED (DB: openai / gpt-5.4), but the page showed
 * Claude Sonnet 5 again after every save. Two causes: the save only revalidated the Employees LIST, so the
 * employee's own page kept its stale server data; and React resets a <form action> after it completes, putting the
 * fields back to those stale values. A second Save from that state would have written the old model back.
 *
 * Fix: revalidate the employee page too, and key the form on the saved values so a successful save remounts it
 * from the fresh data (the reset then hits the discarded instance, never what the owner sees).
 */

/** Every page that shows an employee's saved settings and must be revalidated after a save. */
export function employeePagePaths(projectKey: string, employeeId: string): string[] {
  const base = `/p/${projectKey}/agents`;
  return [base, `${base}/${employeeId}`];
}

/** The fields the agent form shows. */
export interface AgentFormIdentity {
  id: string;
  provider: string;
  model: string;
  systemPrompt: string;
  reviewRubric: string | null;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
}

/** FNV-1a, 32-bit — a short, stable digest so long prompts don't become the key. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** React key for the identity form (name, title, department, manager, active). */
export function employeeFormKey(e: { id: string; name: string; title: string | null; departmentId: string | null; reportsToId: string | null; enabled: boolean }): string {
  return [e.id, fnv1a(e.name), fnv1a(e.title ?? ''), e.departmentId ?? '', e.reportsToId ?? '', e.enabled ? 1 : 0].join(':');
}

/** React key for the agent form: changes whenever any saved value it shows changes. */
export function agentFormKey(a: AgentFormIdentity): string {
  return [
    a.id,
    a.provider,
    a.model,
    a.temperatureMilli,
    a.maxOutputTokens,
    a.enabled ? 1 : 0,
    fnv1a(a.systemPrompt),
    fnv1a(a.reviewRubric ?? ''),
  ].join(':');
}
