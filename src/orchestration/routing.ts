import { type ModelTier } from '@/types/domain';
import { type ProviderId } from '@/types/provider';

/**
 * Model tier routing (SPRINT-03-PLAN.md §4, D-014).
 *
 * `standard` keeps each agent's configured model (seeded: gpt-5.4-mini /
 * claude-sonnet-5). `flagship` overrides to the flagship model for the agent's
 * provider, preserving the cross-vendor review pairing (D-005) in both tiers.
 *
 * The tier is chosen by a human on the task form and stored on the task.
 * Nothing in this module — and nothing that may ever replace it — takes model
 * output as an input: routing must stay deterministic and content-independent,
 * or injected task content could escalate its own spend (SPRINT-03-PLAN §2.3).
 */

/**
 * Executive decision 2026-07-24: the flagship tier uses models whose pricing
 * is verifiable on the vendor's public page. gpt-5.2 was delisted, so the
 * OpenAI flagship moved to gpt-5.4 ($2.50/$15, verified). gpt-5.2 remains
 * callable via per-agent configuration; it is simply not a platform default.
 */
const FLAGSHIP_MODELS: Readonly<Record<ProviderId, string>> = {
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-8',
  google: 'gemini-3-pro',
  deepseek: 'deepseek-reasoner',
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
