import 'server-only';
import {
  type AgentRequest,
  type AgentResponse,
  type AIProvider,
  type AuthoritativeNotExecutedGuarantee,
  type ModelDescriptor,
  ProviderError,
  type ProviderId,
} from '@/types/provider';

/**
 * TEST-ONLY in-app provider. Lets the REAL running app (dev server) execute a run end to end with NO external
 * model call and NO spend, so the browser run-to-result checks are billing-free. It is activated ONLY by
 * `getProvider` when `testFakeProvidersEnabled()` is true, which is hard-fenced to non-production, explicit
 * opt-in, and no Fly runtime (see registry.ts). It is never used by any production code path.
 *
 * Deterministic behavior (keyed off the dispatched request so one server launch covers every case):
 *   - A REVIEW call (its prompt references the `review-result` protocol):
 *       · if the request text contains the marker `REVIEWFAIL` → throw a CONCLUSIVE not-executed ProviderError
 *         ('auth'), i.e. a reviewer that is cleanly unavailable → a REQUIRED review is unmet (unreviewed draft);
 *       · otherwise → return a well-formed `approve` verdict.
 *   - Any other call (primary, revision, post-run extraction) → a plain, action-free answer.
 */
const APPROVE_REVIEW = '```review-result\n' + JSON.stringify({ verdict: 'approve', findings: [] }) + '\n```';
const PRIMARY_ANSWER = 'Local fake answer (HUB_TEST_FAKE_PROVIDERS) — no external model call was made.';

class InAppFakeProvider implements AIProvider {
  readonly id: ProviderId;
  // Mirrors the test harness fake: these kinds are PROVABLY rejected before the model runs, so the engine
  // treats a thrown 'auth' as a clean not-executed failure (not an ambiguous, maybe-charged outcome).
  readonly authoritativeNotExecuted: AuthoritativeNotExecutedGuarantee = {
    support: 'error_kinds',
    errorKinds: new Set(['auth', 'rate_limited', 'invalid_request']),
    basis: 'in-app fake rejects deterministically before execute returns',
  };
  constructor(id: ProviderId) {
    this.id = id;
  }
  async execute(request: AgentRequest): Promise<AgentResponse> {
    const blob = `${request.system}\n${request.turns.map((t) => t.content).join('\n')}`;
    const isReview = blob.includes('review-result');
    if (isReview) {
      if (blob.includes('REVIEWFAIL')) {
        throw new ProviderError(this.id, 'auth', 'fake reviewer unavailable (REVIEWFAIL marker)');
      }
      return this.reply(request.model, APPROVE_REVIEW);
    }
    return this.reply(request.model, PRIMARY_ANSWER);
  }
  private reply(model: string, text: string): AgentResponse {
    return { provider: this.id, model, text, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop', latencyMs: 1 };
  }
  listModels(): readonly ModelDescriptor[] {
    return [{ id: 'fake-model', provider: this.id, displayName: 'In-App Fake', maxOutputTokens: 4096 }];
  }
}

const cache = new Map<ProviderId, AIProvider>();
export function getInAppFakeProvider(id: ProviderId): AIProvider {
  let p = cache.get(id);
  if (!p) {
    p = new InAppFakeProvider(id);
    cache.set(id, p);
  }
  return p;
}
