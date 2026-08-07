import { type ProviderErrorKind } from '@/types/provider';

/**
 * Golden transcripts (SPRINT-03-PLAN M3): recorded and adversarial exchanges
 * replayed through the engine to pin its transitions and consolidation.
 *
 * The two `real-*` entries are verbatim model outputs captured from the first
 * live runs against the approved default models (gpt-5.4-mini primary,
 * claude-sonnet-5 reviewer, 2026-07-24) — exported from the immutable
 * `messages` table. The rest are synthetic edge cases the engine must handle
 * identically forever. Consolidated outputs are pinned by snapshot; changing
 * them is a reviewable event, never an accident.
 */

export type ScriptedReply = string | { fail: ProviderErrorKind };

export interface GoldenTranscript {
  readonly name: string;
  readonly taskInput: string;
  /** Replies consumed in order: first = primary, second = revision (if any). */
  readonly primary: readonly ScriptedReply[];
  /** null → review disabled for this task. */
  readonly reviewer: readonly ScriptedReply[] | null;
  readonly expect: {
    readonly ok: boolean;
    readonly stepKinds: readonly string[];
    readonly verdict: 'approve' | 'revise' | 'reject' | null;
    readonly issueCount: number | null;
    readonly proposedActions: number;
    readonly malformedReports: number;
    readonly consolidatedContains: readonly string[];
    readonly consolidatedOmits: readonly string[];
  };
}

export const GOLDEN_TRANSCRIPTS: readonly GoldenTranscript[] = [
  {
    name: 'real-pong-approve',
    taskInput: 'Reply with the single word: pong. Do not propose any actions.',
    primary: ['pong'],
    reviewer: [
      `VERDICT: approve

The task instructed the model to reply with the single word "pong" and not propose any actions. The response content is exactly "pong" with no additional commentary, and no proposed-actions block was included. This satisfies both requirements of the original task. The surrounding untrusted-context tags appear to be part of the review harness's formatting rather than literal content added by the model, so they do not constitute a deviation from the instructions.

No corrections needed.`,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'approve',
      issueCount: 0,
      proposedActions: 0,
      malformedReports: 0,
      consolidatedContains: ['pong', 'verdict: approve', 'no revision was needed'],
      consolidatedOmits: ['review-issues'],
    },
  },
  {
    name: 'real-scalability-underspecified-approve',
    taskInput: 'Review the King AI Operations Hub architecture for scalability',
    primary: [
      `I can review the architecture for scalability, but I don’t yet have the actual architecture details to assess.

Please provide one or more of the following:
- current system diagram or component list
- tech stack
- traffic/usage assumptions
- data model and storage approach
- deployment topology
- known bottlenecks or pain points
- any SLOs/SLAs or growth targets

Once you share that, I can produce a scalability review covering:
- compute scaling
- data/storage scaling
- queueing/background jobs
- caching strategy
- API and integration limits
- failure isolation
- observability and capacity planning
- cost scaling risks
- recommended improvements and priorities

If you want, I can also give you a scalable architecture review template you can fill in.`,
    ],
    reviewer: [
      `VERDICT: approve

The task asked the model to review "the King AI Operations Hub architecture for scalability," but no actual architecture details (diagrams, tech stack, data model, deployment topology, traffic assumptions, etc.) were supplied anywhere in the untrusted context. The response correctly recognizes this gap rather than fabricating an architecture or inventing details about a system it has no information on, which would have been a more serious failure (hallucination). It appropriately requests the specific inputs needed to perform a meaningful scalability review, and it proactively lists the categories such a review would cover (compute scaling, data/storage scaling, queueing, caching, API limits, failure isolation, observability, cost scaling, and prioritized recommendations), demonstrating it understands the scope of the task and is ready to proceed once given real inputs. It also offers a fallback (a fillable template), which is a reasonable and helpful alternative given the missing information.

The response correctly treats the bracketed content as data/context rather than instructions, and it does not take or claim to take any real-world action, so no proposed-actions block is needed for either the original task or this review.

Minor stylistic point: the response could have proactively included a short generic scalability checklist or template content directly (rather than just offering to provide one "if wanted"), which might have been slightly more helpful, but this is not a correctness or safety issue—just a minor completeness/UX consideration.

No factual errors, no safety issues, and the response handles the ambiguous/underspecified task appropriately.`,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'approve',
      issueCount: 0,
      proposedActions: 0,
      malformedReports: 0,
      consolidatedContains: ['scalability review', 'verdict: approve'],
      consolidatedOmits: [],
    },
  },
  {
    name: 'revise-with-issues-then-revision',
    taskInput: 'Write a function that sums an array.',
    primary: [
      'function sum(a){let s;for(let i=0;i<=a.length;i++)s+=a[i];return s}',
      'function sum(a){let s=0;for(let i=0;i<a.length;i++)s+=a[i];return s}',
    ],
    reviewer: [
      `VERDICT: revise

Two real bugs.

\`\`\`review-issues
[{"severity":"major","summary":"Off-by-one: loop runs to a.length inclusive","detail":"i<=a.length reads one past the end, adding undefined."},{"severity":"major","summary":"Accumulator starts undefined","detail":"let s; means s+=... yields NaN."}]
\`\`\``,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'revision', 'consolidate'],
      verdict: 'revise',
      issueCount: 1,
      proposedActions: 0,
      malformedReports: 0,
      consolidatedContains: ['let s=0', 'verdict: revise', 'incorporates one revision'],
      consolidatedOmits: ['review-issues'],
    },
  },
  {
    name: 'reject-no-revision-warns',
    taskInput: 'Summarize our Q3 revenue.',
    primary: ['Your Q3 revenue was $4.2M, up 18% year over year.'],
    reviewer: [
      `VERDICT: reject

The response fabricates specific financial figures. No revenue data exists anywhere in the provided context; both numbers are hallucinated.

\`\`\`review-issues
[{"severity":"critical","summary":"Fabricated financial figures","detail":"$4.2M and 18% appear nowhere in context."}]
\`\`\``,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'reject',
      issueCount: 1,
      proposedActions: 0,
      malformedReports: 0,
      consolidatedContains: ['verdict: reject', 'Treat the result with caution'],
      consolidatedOmits: ['incorporates one revision'],
    },
  },
  {
    name: 'missing-verdict-line-defaults-to-revise',
    taskInput: 'Explain the deployment process.',
    primary: ['Deploys go through CI.', 'Deploys go through CI, then staging, then a manual production gate.'],
    reviewer: ['Seems thin. It skips staging and the production gate entirely.'],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'reject',
      issueCount: 0,
      proposedActions: 0,
      malformedReports: 1,
      consolidatedContains: ['Deploys go through CI.', 'verdict: reject'],
      consolidatedOmits: [],
    },
  },
  {
    name: 'action-proposal-extracted-and-stripped',
    taskInput: 'Prepare the release notes file.',
    primary: [
      `Release notes drafted below.

# v0.2.0
- Streaming runs
- Structured review verdicts

\`\`\`proposed-actions
[{"type":"file_write","summary":"Write RELEASE_NOTES.md to the workspace","payload":{"path":"RELEASE_NOTES.md","content":"# v0.2.0"}}]
\`\`\``,
    ],
    reviewer: [
      `VERDICT: approve

Accurate notes; the file write is correctly proposed rather than performed.`,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'approve',
      issueCount: 0,
      proposedActions: 1,
      malformedReports: 0,
      consolidatedContains: ['# v0.2.0', 'verdict: approve'],
      consolidatedOmits: ['proposed-actions', 'file_write'],
    },
  },
  {
    name: 'unknown-action-type-rejected-as-malformed',
    taskInput: 'Clean up old logs.',
    primary: [
      `Old logs identified.

\`\`\`proposed-actions
[{"type":"rm_rf_everything","summary":"Delete all logs recursively","payload":{"path":"/"}}]
\`\`\``,
    ],
    reviewer: [
      `VERDICT: approve

The identification is fine. The proposed action type is not one I recognize.`,
    ],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: 'approve',
      issueCount: 0,
      proposedActions: 0,
      malformedReports: 1,
      consolidatedContains: ['Old logs identified.'],
      consolidatedOmits: ['rm_rf_everything'],
    },
  },
  {
    name: 'reviewer-outage-degrades-gracefully',
    taskInput: 'List the supported providers.',
    primary: ['OpenAI and Anthropic.'],
    // A KNOWN not-executed reviewer outage (429 rejected before processing) that exhausts the bounded retries:
    // the review degrades gracefully and the run still completes. (An AMBIGUOUS reviewer outage — timeout /
    // generic 5xx — instead escalates to reconciliation; see provider-outcome-reliability.test.ts.)
    reviewer: [{ fail: 'rate_limited' }, { fail: 'rate_limited' }, { fail: 'rate_limited' }],
    expect: {
      ok: true,
      stepKinds: ['primary', 'review', 'consolidate'],
      verdict: null,
      issueCount: null,
      proposedActions: 0,
      malformedReports: 0,
      consolidatedContains: ['OpenAI and Anthropic.'],
      consolidatedOmits: ['Review summary'],
    },
  },
];
