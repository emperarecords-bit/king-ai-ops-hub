import 'server-only';
import { z } from 'zod';
import { type AIProvider, type ProviderId } from '@/types/provider';
import { getProvider as defaultGetProvider } from '@/providers/registry';

/**
 * Ops Chat — Council review layer (v2 "Council Mode"). OWNER-TRIGGERED, READ/REVIEW ONLY.
 *
 * Council takes an already-produced primary answer and sends it to several
 * INDEPENDENT reviewer models (different roles, and different vendors where
 * configured), then synthesises their concise conclusions into one compact
 * decision aid for the owner. It NEVER runs on its own — the route is only hit
 * when the owner taps "Ask Council" — and it is strictly advisory:
 *
 *   - It performs NO writes and imports NO mutation/DB-write helpers (enforced by
 *     a static read-only guard test). It cannot answer an owner question into
 *     state, decide an approval, create/re-run a task, enqueue work, or trigger
 *     any external action.
 *   - Any action the owner decides to take as a result still goes through the
 *     unchanged v2 propose → POST /api/ops-chat/confirm boundary. Council emits
 *     no executable proposal objects of its own.
 *
 * COST CONTROL (Council is several model calls, so it is bounded hard):
 *   - at most COUNCIL_MAX_REVIEWERS reviewer calls + one synthesis call;
 *   - each reviewer capped at COUNCIL_MAX_REVIEWER_TOKENS output tokens,
 *     synthesis at COUNCIL_MAX_SYNTHESIS_TOKENS;
 *   - per-reviewer wall-clock budget + an overall Council deadline;
 *   - a single attempt per reviewer — NO retries (no retry storm).
 * The owner-scoped per-user rate limit on the route is the request-rate bound.
 *
 * NO HIDDEN CHAIN-OF-THOUGHT: reviewer and synthesis prompts ask for conclusions
 * and one-line reasons only; nothing else is captured or returned.
 */

export type CouncilRole = 'accuracy' | 'risk' | 'alternative';
export type CouncilConfidence = 'low' | 'medium' | 'high';

/** Hard caps (cost control). Exported so tests and the route can assert them. */
export const COUNCIL_MAX_REVIEWERS = 3;
export const COUNCIL_MAX_REVIEWER_TOKENS = 700;
export const COUNCIL_MAX_SYNTHESIS_TOKENS = 900;
export const COUNCIL_REVIEWER_TIMEOUT_MS = 30_000;
export const COUNCIL_OVERALL_TIMEOUT_MS = 60_000;
/** Minimum reviewer conclusions required to synthesise; below this we fail safe. */
export const COUNCIL_QUORUM = 2;

/** Max input sizes accepted into Council (also enforced by the route schema). */
export const COUNCIL_MAX_QUESTION_CHARS = 4000;
export const COUNCIL_MAX_ANSWER_CHARS = 12_000;

/** A reviewer's concise, conclusions-only output (or a graceful failure marker). */
export interface CouncilReviewerResult {
  readonly role: CouncilRole;
  readonly label: string;
  readonly provider: ProviderId;
  readonly ok: boolean;
  /** Concise conclusions only. Empty when ok=false. */
  readonly conclusion: string;
}

export interface CouncilSynthesis {
  readonly agreement: readonly string[];
  readonly disagreements: readonly string[];
  readonly recommendation: string;
  readonly risks: readonly string[];
  readonly confidence: CouncilConfidence;
  readonly ownerDecisionNeeded: readonly string[];
}

export interface CouncilResult {
  readonly synthesis: CouncilSynthesis;
  /** Per-reviewer concise conclusions, for optional drill-down in the UI. */
  readonly reviewers: readonly CouncilReviewerResult[];
  /** True when at least one reviewer failed but quorum still held. */
  readonly degraded: boolean;
}

/**
 * Raised when Council cannot produce a trustworthy result (no providers, quorum
 * not reached, or synthesis failed). Carries a safe, owner-facing message — never
 * a provider/internal detail. The route maps this to 503.
 */
export class CouncilUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilUnavailableError';
  }
}

export interface CouncilInput {
  /** The original owner question that produced the primary answer. */
  readonly question: string;
  /** The primary answer under review. */
  readonly primaryAnswer: string;
  /**
   * Authorized, server-resolved hub context (the same read-only pulse text the
   * primary answer was given). NEVER client-supplied workspace data.
   */
  readonly context: string;
  /** Optional name of the workspace the owner asked Council to focus on. */
  readonly focusWorkspace?: string;
  readonly signal?: AbortSignal;
}

export interface CouncilDeps {
  /** Provider resolver — defaults to the real registry; tests inject fakes. */
  readonly getProvider?: (id: ProviderId) => AIProvider;
}

/** Candidate vendors in preference order for availability probing. */
const CANDIDATE_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google', 'deepseek'];

/** Reviewer model per vendor — cost-aware mid models; all present in pricing. */
const REVIEWER_MODEL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.4-mini',
  google: 'gemini-3.1-flash-lite',
  deepseek: 'deepseek-chat',
};

/** Synthesis always runs on Anthropic when available (falls back to any vendor). */
const SYNTHESIS_PREFERRED: ProviderId = 'anthropic';

const SHARED_REVIEWER_RULES = `
Rules:
- Use ONLY the facts in the OWNER QUESTION, PRIMARY ANSWER, and AUTHORIZED HUB CONTEXT below. Never invent counts, names, statuses, or criteria.
- Give CONCLUSIONS ONLY — short bullet points, each with a one-line reason. Do NOT reveal step-by-step reasoning or chain-of-thought.
- Be concise: at most 5 bullets, under ~120 words total. If you have nothing material to add, say so in one line.
- You are reviewing only. You cannot and must not take any action, approve anything, or claim anything was done.`;

const ROLE_PROMPT: Readonly<Record<CouncilRole, string>> = {
  accuracy: `You are the ACCURACY reviewer on a council reviewing a primary answer for the owner of an AI operations hub.
Identify: unsupported claims, stale or likely-outdated facts, internal contradictions, and anything asserted in the PRIMARY ANSWER that the AUTHORIZED HUB CONTEXT does not support. If it is accurate and well-supported, say so plainly.${SHARED_REVIEWER_RULES}`,
  risk: `You are the RISK reviewer on a council reviewing a primary answer for the owner of an AI operations hub.
Identify operational, security, financial, and data risks in ACTING on the primary answer — irreversible steps, spend, tenant/data exposure, or anything that could go wrong. If the risk is low, say so plainly.${SHARED_REVIEWER_RULES}`,
  alternative: `You are the ALTERNATIVE (adversarial) reviewer on a council reviewing a primary answer for the owner of an AI operations hub.
If a materially different and better approach exists, state it concisely and why. Push back where warranted. If the primary answer is already the best available approach, say so plainly rather than inventing an alternative.${SHARED_REVIEWER_RULES}`,
};

const ROLE_LABEL: Readonly<Record<CouncilRole, string>> = {
  accuracy: 'Accuracy reviewer',
  risk: 'Risk reviewer',
  alternative: 'Alternative reviewer',
};

const VENDOR_LABEL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
  deepseek: 'DeepSeek',
};

const ROLE_ORDER: readonly CouncilRole[] = ['accuracy', 'risk', 'alternative'];

/** Probe which vendors are actually configured (getProvider throws otherwise). */
function availableProviders(getProvider: (id: ProviderId) => AIProvider): ProviderId[] {
  const out: ProviderId[] = [];
  for (const id of CANDIDATE_PROVIDERS) {
    try {
      getProvider(id);
      out.push(id);
    } catch {
      /* not configured — skip */
    }
  }
  return out;
}

/**
 * Assign a vendor to each reviewer role. Preferred council is Anthropic +
 * OpenAI + an adversarial reviewer on a third vendor when one is configured;
 * with fewer vendors, independence of ROLE is kept even if a vendor repeats
 * (branding matters less than independent prompts). Deterministic.
 */
function assignReviewers(available: readonly ProviderId[]): Array<{ role: CouncilRole; provider: ProviderId }> {
  const has = (id: ProviderId): boolean => available.includes(id);
  const first = available[0]!; // caller guarantees non-empty
  const accuracyP: ProviderId = has('anthropic') ? 'anthropic' : first;
  const riskP: ProviderId = has('openai') ? 'openai' : (available.find((x) => x !== accuracyP) ?? accuracyP);
  const third = available.find((x) => x !== 'anthropic' && x !== 'openai');
  const alternativeP: ProviderId =
    third ?? (has('openai') ? 'openai' : has('anthropic') ? 'anthropic' : first);
  const reviewers: Array<{ role: CouncilRole; provider: ProviderId }> = [
    { role: 'accuracy', provider: accuracyP },
    { role: 'risk', provider: riskP },
    { role: 'alternative', provider: alternativeP },
  ];
  return reviewers.slice(0, COUNCIL_MAX_REVIEWERS);
}

function reviewerInput(input: CouncilInput): string {
  const focus = input.focusWorkspace ? `\nOWNER ASKED COUNCIL TO FOCUS ON WORKSPACE: ${input.focusWorkspace}` : '';
  return (
    `OWNER QUESTION:\n${input.question}\n\n` +
    `PRIMARY ANSWER (under review):\n${input.primaryAnswer}\n\n` +
    `AUTHORIZED HUB CONTEXT (read-only facts; the only data you may rely on):\n${input.context}${focus}`
  );
}

/** Clamp any model output to a safe size before it leaves the server. */
function clampConclusion(text: string): string {
  const t = text.trim();
  return t.length > 2000 ? `${t.slice(0, 2000)}…` : t;
}

async function runReviewer(
  getProvider: (id: ProviderId) => AIProvider,
  assignment: { role: CouncilRole; provider: ProviderId },
  input: CouncilInput,
  signal: AbortSignal,
): Promise<CouncilReviewerResult> {
  const label = `${ROLE_LABEL[assignment.role]} (${VENDOR_LABEL[assignment.provider]})`;
  try {
    const provider = getProvider(assignment.provider);
    const res = await provider.execute({
      model: REVIEWER_MODEL[assignment.provider],
      system: ROLE_PROMPT[assignment.role],
      turns: [{ role: 'user', content: reviewerInput(input) }],
      temperature: 0.2,
      maxOutputTokens: COUNCIL_MAX_REVIEWER_TOKENS,
      timeoutMs: COUNCIL_REVIEWER_TIMEOUT_MS,
      signal,
    });
    const conclusion = clampConclusion(res.text ?? '');
    if (!conclusion) return { role: assignment.role, label, provider: assignment.provider, ok: false, conclusion: '' };
    return { role: assignment.role, label, provider: assignment.provider, ok: true, conclusion };
  } catch {
    // Single attempt, no retry. A failed reviewer degrades gracefully.
    return { role: assignment.role, label, provider: assignment.provider, ok: false, conclusion: '' };
  }
}

const SYNTHESIS_SYSTEM = `You are the COUNCIL SYNTHESISER for the owner of an AI operations hub. You are given the owner's question, the primary answer, and several independent reviewer conclusions. Produce one compact decision aid.

You do NOT take any action and cannot change any system state. You only summarise.

Return STRICT JSON and NOTHING else — no prose, no markdown fences, no chain-of-thought. Shape:
{
  "agreement": string[],          // points the reviewers agree on
  "disagreements": string[],      // each a one-line "X vs Y" disagreement; [] if none
  "recommendation": string,       // the single strongest recommendation, concise
  "risks": string[],              // key risks / caveats the owner should weigh
  "confidence": "low" | "medium" | "high",
  "ownerDecisionNeeded": string[] // what still needs the owner's judgement
}
Keep every string short. Use only the reviewer conclusions and the given facts; invent nothing.`;

const SynthesisSchema = z.object({
  agreement: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  disagreements: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  recommendation: z.string().trim().max(1500).default(''),
  risks: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  ownerDecisionNeeded: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
});

/** Pull the first balanced JSON object out of a model response (tolerates fences/prose). */
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function synthesise(
  getProvider: (id: ProviderId) => AIProvider,
  synthProvider: ProviderId,
  input: CouncilInput,
  reviewers: readonly CouncilReviewerResult[],
  signal: AbortSignal,
): Promise<CouncilSynthesis> {
  const reviewerBlock = reviewers
    .filter((r) => r.ok)
    .map((r) => `### ${r.label}\n${r.conclusion}`)
    .join('\n\n');
  const user =
    `OWNER QUESTION:\n${input.question}\n\n` +
    `PRIMARY ANSWER:\n${input.primaryAnswer}\n\n` +
    `INDEPENDENT REVIEWER CONCLUSIONS:\n${reviewerBlock}`;
  let res;
  try {
    res = await getProvider(synthProvider).execute({
      model: REVIEWER_MODEL[synthProvider],
      system: SYNTHESIS_SYSTEM,
      turns: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxOutputTokens: COUNCIL_MAX_SYNTHESIS_TOKENS,
      timeoutMs: COUNCIL_REVIEWER_TIMEOUT_MS,
      signal,
    });
  } catch {
    // Provider error / abort / overall-timeout during synthesis → safe unavailable.
    throw new CouncilUnavailableError('The council could not produce a usable summary. Try again.');
  }
  const json = extractJson(res.text ?? '');
  if (!json) throw new CouncilUnavailableError('The council could not produce a usable summary. Try again.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CouncilUnavailableError('The council could not produce a usable summary. Try again.');
  }
  const result = SynthesisSchema.safeParse(parsed);
  if (!result.success) {
    throw new CouncilUnavailableError('The council could not produce a usable summary. Try again.');
  }
  return result.data;
}

/**
 * Run the council: fan out to independent reviewers, then synthesise. Pure
 * review — no writes, no proposals, no state change. Fails SAFE (throws
 * CouncilUnavailableError) when no providers are configured, quorum is not
 * reached, or synthesis fails.
 */
export async function runCouncil(input: CouncilInput, deps: CouncilDeps = {}): Promise<CouncilResult> {
  const getProvider = deps.getProvider ?? defaultGetProvider;

  const available = availableProviders(getProvider);
  if (available.length === 0) {
    throw new CouncilUnavailableError('No review models are currently configured. Council is unavailable.');
  }

  const assignments = assignReviewers(available);
  // Order the roles deterministically for display regardless of assignment order.
  assignments.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  // ONE overall Council deadline covering BOTH the reviewer fan-out and the
  // synthesis (links to the caller's abort if given). Single attempt per reviewer
  // and for synthesis — aborting cancels all in-flight provider calls. No retries.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }
  const deadline = setTimeout(() => controller.abort(), COUNCIL_OVERALL_TIMEOUT_MS);

  try {
    const reviewers = await Promise.all(
      assignments.map((a) => runReviewer(getProvider, a, input, controller.signal)),
    );

    const succeeded = reviewers.filter((r) => r.ok);
    if (succeeded.length < COUNCIL_QUORUM) {
      throw new CouncilUnavailableError(
        'The council could not reach enough reviewers to be useful. Nothing was changed — try again.',
      );
    }

    const synthProvider: ProviderId = available.includes(SYNTHESIS_PREFERRED) ? SYNTHESIS_PREFERRED : available[0]!;
    const synthesis = await synthesise(getProvider, synthProvider, input, succeeded, controller.signal);

    return { synthesis, reviewers, degraded: succeeded.length < reviewers.length };
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
