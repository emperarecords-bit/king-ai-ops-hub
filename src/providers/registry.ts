import 'server-only';
import { type AIProvider, type ProviderId } from '@/types/provider';
import { serverEnv } from '@/lib/env.server';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { OpenAICompatibleProvider } from './openai-compatible';

/**
 * Server-side provider registry. Keys are read here, once, from server env —
 * this module imports `server-only`, so the adapters can never end up in a
 * client bundle.
 */

let registry: Map<ProviderId, AIProvider> | null = null;

/**
 * Test-only injection seam. Lets an integration test drive the REAL production dispatch path
 * (`startRun` → `getProvider`) with a fake provider so no external model call or spend occurs. Returns a
 * provider to use for `id`, or `undefined` to fall through to the real registry. Never set in production
 * code paths — only from tests, which must clear it (`setProviderOverrideForTests(null)`) afterward.
 */
let providerOverride: ((id: ProviderId) => AIProvider | undefined) | null = null;
export function setProviderOverrideForTests(
  fn: ((id: ProviderId) => AIProvider | undefined) | null,
): void {
  providerOverride = fn;
}

export function getProvider(id: ProviderId): AIProvider {
  if (providerOverride) {
    const injected = providerOverride(id);
    if (injected) return injected;
  }
  if (!registry) {
    const env = serverEnv();
    registry = new Map<ProviderId, AIProvider>([
      ['openai', new OpenAIProvider(env.OPENAI_API_KEY)],
      ['anthropic', new AnthropicProvider(env.ANTHROPIC_API_KEY)],
    ]);
    // Optional vendors: registered only when their key is configured, so a
    // deployment without them still boots. getProvider fails with a clear
    // remedial message instead of constructing a client around undefined.
    if (env.GEMINI_API_KEY) {
      registry.set(
        'google',
        new OpenAICompatibleProvider({
          id: 'google',
          label: 'Gemini',
          baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
          apiKey: env.GEMINI_API_KEY,
        }),
      );
    }
    if (env.DEEPSEEK_API_KEY) {
      registry.set(
        'deepseek',
        new OpenAICompatibleProvider({
          id: 'deepseek',
          label: 'DeepSeek',
          baseURL: 'https://api.deepseek.com',
          apiKey: env.DEEPSEEK_API_KEY,
        }),
      );
    }
  }
  const provider = registry.get(id);
  if (!provider) {
    throw new Error(
      `Provider '${id}' is not configured. Set ${KEY_VAR_FOR[id] ?? 'its API key'} in the server environment.`,
    );
  }
  return provider;
}

const KEY_VAR_FOR: Partial<Record<ProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * The reviewer for cross-provider review is always ANOTHER vendor (D-005).
 * The pairing is a fixed map so routing stays deterministic and
 * content-independent; both directions of the original pair are preserved.
 */
const CROSS_VENDOR_REVIEWER: Readonly<Record<ProviderId, ProviderId>> = {
  openai: 'anthropic',
  anthropic: 'openai',
  google: 'anthropic',
  deepseek: 'openai',
};

export function otherProvider(id: ProviderId): ProviderId {
  return CROSS_VENDOR_REVIEWER[id];
}
