import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeProviderEnvError,
  getProvider,
  setProviderOverrideForTests,
  testFakeProvidersEnabled,
} from '@/providers/registry';
import type { AgentRequest } from '@/types/provider';

/**
 * Answer-routing Phase 1 — the test-only in-app fake provider FENCE. Proves fake-only mode fails CLOSED on an
 * incompatible serving environment (never falling through to the real adapters), is off entirely when the flag
 * is unset (ordinary production behavior unchanged), and selects the fake only on a compatible local runtime.
 */

const req: AgentRequest = { model: 'm', system: 's', turns: [{ role: 'user', content: 'hi' }], temperature: 0, maxOutputTokens: 8, timeoutMs: 1000 };

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

afterEach(() => setProviderOverrideForTests(null));

describe('in-app fake provider fence', () => {
  it('flag UNSET → fakes off (normal provider path, unchanged)', () => {
    withEnv({ HUB_TEST_FAKE_PROVIDERS: undefined }, () => {
      expect(testFakeProvidersEnabled()).toBe(false);
    });
  });

  it('flag=1 on a compatible LOCAL runtime → selects the in-app fake', async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = { flag: env.HUB_TEST_FAKE_PROVIDERS, node: env.NODE_ENV };
    env.HUB_TEST_FAKE_PROVIDERS = '1';
    env.NODE_ENV = 'test';
    delete env.FLY_APP_NAME; delete env.FLY_MACHINE_ID; delete env.FLY_ALLOC_ID;
    try {
      expect(testFakeProvidersEnabled()).toBe(true);
      const p = getProvider('openai'); // selected while the fence is open
      const res = await p.execute(req);
      expect(res.text).toContain('HUB_TEST_FAKE_PROVIDERS');
    } finally {
      if (prev.flag === undefined) delete env.HUB_TEST_FAKE_PROVIDERS; else env.HUB_TEST_FAKE_PROVIDERS = prev.flag;
      env.NODE_ENV = prev.node;
    }
  });

  it('flag=1 on PRODUCTION → FAILS CLOSED (throws, zero real-adapter activity)', () => {
    withEnv({ HUB_TEST_FAKE_PROVIDERS: '1', NODE_ENV: 'production' }, () => {
      expect(() => testFakeProvidersEnabled()).toThrow(FakeProviderEnvError);
      // getProvider throws BEFORE constructing/returning any real adapter — no normal-provider path is taken.
      expect(() => getProvider('openai')).toThrow(FakeProviderEnvError);
    });
  });

  it('flag=1 on a FLY runtime → FAILS CLOSED (throws)', () => {
    withEnv({ HUB_TEST_FAKE_PROVIDERS: '1', NODE_ENV: 'test', FLY_APP_NAME: 'king-ai-ops-hub-prod' }, () => {
      expect(() => testFakeProvidersEnabled()).toThrow(FakeProviderEnvError);
      expect(() => getProvider('anthropic')).toThrow(FakeProviderEnvError);
    });
  });
});
