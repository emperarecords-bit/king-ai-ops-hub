/**
 * Structured approval details (VER-002, Priority 6 / spec Priority 3).
 *
 * Completes what an approver must see for a consequential action: the exact
 * action, target, purpose, information transmitted, expected writes, and known
 * or unknown cost — and separates an INTERNAL assignment (e.g. dispatching a
 * task to an agent) from an EXTERNAL request (an outbound HTTP call / repo
 * write). Approval never implies that execution access exists.
 */

/** Action types that reach or change a system outside the tenant. */
const EXTERNAL_ACTIONS = new Set([
  'email_send',
  'social_publish',
  'external_http',
  'git_pr',
  'git_push',
  'git_commit',
  'deployment',
  'financial',
]);

const TARGET_KEYS = ['to', 'recipient', 'url', 'endpoint', 'repo', 'repoFullName', 'branch', 'path', 'file', 'table', 'environment', 'account'];

export interface ApprovalActionInput {
  readonly actionType: string;
  readonly payload: Record<string, unknown>;
  readonly purpose: string;
  /** Supply when a real cost is known; omit to declare it explicitly unknown. */
  readonly cost?: { readonly amount: number; readonly unit: string };
}

export interface ApprovalDetails {
  readonly action: string;
  readonly scope: 'internal' | 'external';
  readonly target: { readonly established: boolean; readonly value: string | null; readonly note: string };
  readonly purpose: string;
  readonly transmittedInformation: { readonly leavesTenant: boolean; readonly description: string };
  readonly expectedWrites: string;
  readonly cost: { readonly known: boolean; readonly amount: number | null; readonly unit: string | null; readonly note: string };
  /** Explicit reminder: authorizing is not proof that an executor is enabled. */
  readonly executionCaveat: string;
}

function deriveTarget(payload: Record<string, unknown>): { established: boolean; value: string | null } {
  for (const k of TARGET_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) return { established: true, value: `${k}=${v}` };
  }
  return { established: false, value: null };
}

function expectedWrites(actionType: string, payload: Record<string, unknown>, target: string | null): string {
  switch (actionType) {
    case 'git_pr':
      return `Creates a branch, commit, and pull request in ${payload.repoFullName ?? payload.repo ?? 'the linked repo'} (no default-branch write).`;
    case 'git_push':
    case 'git_commit':
      return `Writes commits to ${target ?? 'a non-default branch'}.`;
    case 'email_send':
      return `Sends 1 email to ${payload.to ?? payload.recipient ?? 'the recipient'}.`;
    case 'social_publish':
      return 'Publishes 1 post to the connected social account.';
    case 'external_http':
      return `Sends an HTTP request to ${payload.url ?? payload.endpoint ?? 'the endpoint'}.`;
    case 'deployment':
      return `Deploys to ${payload.environment ?? 'the target environment'}.`;
    case 'db_mutation':
      return `Mutates rows matching: ${payload.predicate ?? payload.table ?? 'the specified rows'}.`;
    case 'org_delegation':
      return `Queues 1 internal task run for agent ${payload.agentId ?? payload.agentName ?? 'the assignee'} (no external side effect).`;
    case 'file_write':
      return `Writes to ${target ?? 'the specified path'} (internal, dry-run only today).`;
    case 'financial':
      return `Moves ${payload.amount ?? 'funds'} — financial, execution is prohibited by the risk gate.`;
    default:
      return 'Unspecified write set — treat as consequential until modeled.';
  }
}

export function describeApprovalDetails(input: ApprovalActionInput): ApprovalDetails {
  const external = EXTERNAL_ACTIONS.has(input.actionType);
  const target = deriveTarget(input.payload);
  return {
    action: input.actionType,
    scope: external ? 'external' : 'internal',
    target: {
      established: target.established,
      value: target.value,
      note: target.established ? 'Target read from the proposed payload.' : 'No target locator found in the payload.',
    },
    purpose: input.purpose,
    transmittedInformation: {
      leavesTenant: external,
      description: external
        ? `Data leaves the tenant to ${target.value ?? 'the external target'}: the proposed payload is transmitted verbatim.`
        : 'Internal assignment only — no data leaves the tenant.',
    },
    expectedWrites: expectedWrites(input.actionType, input.payload, target.value),
    cost: input.cost
      ? { known: true, amount: input.cost.amount, unit: input.cost.unit, note: 'Cost supplied with the action.' }
      : {
          known: false,
          amount: null,
          unit: null,
          note:
            input.actionType === 'org_delegation'
              ? 'Unknown: starts an AI run whose token cost depends on the work.'
              : 'Unknown: no cost estimate was provided for this action.',
        },
    executionCaveat:
      'Authorizing records intent for exactly this action. It does not prove an executor is enabled or that execution access exists.',
  };
}
