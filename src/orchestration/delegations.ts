import { z } from 'zod';

/**
 * GM delegation (TB-4 sibling of actions.ts). The workspace's General Manager — and ONLY the GM;
 * the runner enforces identity at the trust boundary — may end a reply with a `delegated-tasks`
 * block. Each entry becomes a REAL task for a named employee, created and queued automatically:
 * internal, reversible work that spends no external authority. Anything consequential a delegated
 * employee then proposes still flows through the approvals queue like all other work.
 *
 * Everything here is hostile until it survives the Zod parse: malformed entries are reported,
 * never repaired, and never fail the GM's own run.
 */

export const DELEGATION_BLOCK_OPEN = '```delegated-tasks';
export const MAX_DELEGATIONS_PER_RUN = 5;

const delegatedTaskSchema = z
  .object({
    /** EXACT employee name in this workspace (the prompt lists the roster verbatim). */
    assignee: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    /** Complete, self-contained work instructions — the assignee sees nothing else. */
    instructions: z.string().trim().min(1).max(8_000),
  })
  .strict();

export interface DelegatedTask {
  readonly assignee: string;
  readonly title: string;
  readonly instructions: string;
}

export interface DelegationExtraction {
  readonly delegations: readonly DelegatedTask[];
  readonly rejected: readonly string[];
}

export function extractDelegatedTasks(modelText: string): DelegationExtraction {
  const rejected: string[] = [];
  const fenceStart = modelText.lastIndexOf(DELEGATION_BLOCK_OPEN);
  if (fenceStart === -1) return { delegations: [], rejected };

  const afterFence = modelText.slice(fenceStart + DELEGATION_BLOCK_OPEN.length);
  const fenceEnd = afterFence.indexOf('```');
  if (fenceEnd === -1) {
    rejected.push('Unterminated delegated-tasks block.');
    return { delegations: [], rejected };
  }

  const raw = afterFence.slice(0, fenceEnd).trim();
  if (raw.length === 0) return { delegations: [], rejected };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rejected.push('delegated-tasks block is not valid JSON.');
    return { delegations: [], rejected };
  }
  if (!Array.isArray(parsed)) {
    rejected.push('delegated-tasks block must be a JSON array.');
    return { delegations: [], rejected };
  }
  if (parsed.length > MAX_DELEGATIONS_PER_RUN) {
    rejected.push(`Model delegated ${parsed.length} tasks; only the first ${MAX_DELEGATIONS_PER_RUN} were considered.`);
  }

  const delegations: DelegatedTask[] = [];
  for (const [index, candidate] of parsed.slice(0, MAX_DELEGATIONS_PER_RUN).entries()) {
    const result = delegatedTaskSchema.safeParse(candidate);
    if (!result.success) {
      rejected.push(`Delegation ${index} rejected: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    delegations.push(result.data);
  }
  return { delegations, rejected };
}

/**
 * Appended to the GM's system prompt ONLY (the runner decides — an employee's prompt never carries
 * this, and a delegation block emitted by a non-GM is dropped and audited at finalization).
 */
export function buildDelegationRules(roster: readonly string[]): string {
  const names = roster.length > 0 ? roster.map((n) => `"${n}"`).join(', ') : '(no enabled employees)';
  return `
You are this workspace's General Manager, and you can DELEGATE real work: tasks you assign are created and run automatically, without waiting for the owner. Anything consequential your employees then propose still goes to the owner's approvals queue.
- To delegate, end your reply with a single fenced block:
${DELEGATION_BLOCK_OPEN}
[{"assignee": "<exact employee name>", "title": "<short task title>", "instructions": "<complete, self-contained instructions - the assignee sees ONLY this text>"}]
\`\`\`
- You may assign to exactly these employees (use the name verbatim): ${names}.
- At most ${MAX_DELEGATIONS_PER_RUN} delegations per reply. Never assign to yourself.
- Delegate whenever work should advance: break the owner's goals into concrete next tasks, assign each to the right specialist, and re-check results in your next standup. Prefer delegating over merely describing what should happen.`;
}
