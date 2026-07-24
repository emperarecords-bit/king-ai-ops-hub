import 'server-only';
import { type AIProvider, type ProviderId } from '@/types/provider';
import { serverEnv } from '@/lib/env.server';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

/**
 * Server-side provider registry. Keys are read here, once, from server env —
 * this module imports `server-only`, so the adapters can never end up in a
 * client bundle.
 */

let registry: Map<ProviderId, AIProvider> | null = null;

export function getProvider(id: ProviderId): AIProvider {
  if (!registry) {
    const env = serverEnv();
    registry = new Map<ProviderId, AIProvider>([
      ['openai', new OpenAIProvider(env.OPENAI_API_KEY)],
      ['anthropic', new AnthropicProvider(env.ANTHROPIC_API_KEY)],
    ]);
  }
  const provider = registry.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** The reviewer for cross-provider review is always the OTHER vendor (D-005). */
export function otherProvider(id: ProviderId): ProviderId {
  return id === 'openai' ? 'anthropic' : 'openai';
}
