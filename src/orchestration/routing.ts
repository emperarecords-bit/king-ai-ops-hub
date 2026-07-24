import { type ModelTier } from '@/types/domain';
import { type ProviderId } from '@/types/provider';

/**
 * Model tier routing (SPRINT-03-PLAN.md §4, D-014).
 *
 * `standard` keeps each agent's configured model (seeded: gpt-5.2-mini /
 * claude-sonnet-5). `flagship` overrides to the flagship model for the agent's
 * provider, preserving the cross-vendor review pairing (D-005) in both tiers.
 *
 * The tier is chosen by a human on the task form and stored on the task.
 * Nothing in this module — and nothing that may ever replace it — takes model
 * output as an input: routing must stay deterministic and content-independent,
 * or injected task content could escalate its own spend (SPRINT-03-PLAN §2.3).
 */

const FLAGSHIP_MODELS: Readonly<Record<ProviderId, string>> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-opus-4-8',
};

/**
 * The model an agent should run with under the given tier. `configuredModel`
 * is the agent's own setting, which is the standard-tier answer.
 */
export function resolveModelForTier(
  tier: ModelTier,
  provider: ProviderId,
  configuredModel: string,
): string {
  if (tier === 'flagship') return FLAGSHIP_MODELS[provider];
  return configuredModel;
}
