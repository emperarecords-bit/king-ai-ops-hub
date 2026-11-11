import { afterEach, describe, expect, it } from 'vitest';
import { __resetServerEnvCache, serverEnv } from '@/lib/env.server';

/**
 * Connector credentials (GitHub App, Supabase Management, Vercel) are OPTIONAL: each client fails
 * closed without one, so absence is a safe posture and the production gate must NOT require them.
 * What it must reject is a credential that is PRESENT BUT UNUSABLE, because `is*Configured()` only
 * tests truthiness — a placeholder reports the connector as configured and moves the failure from
 * boot to the first live API call.
 *
 * Every assertion here has a positive control: the same env that is rejected with a placeholder
 * boots with a real value, and the all-absent case boots too. A gate that rejected everything, or
 * nothing, would fail this file.
 */

const REAL = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app_server:a-real-strong-pw@db.internal:5432/king_ai_hub',
  OPENAI_API_KEY: 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-live-abcdefghijklmnopqrstuvwxyz0123456789',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  NEXT_PUBLIC_SUPABASE_URL: 'https://real-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  // Keep the unrelated S3 branch out of these assertions, and never inherit an ambient credential.
  STORAGE_DRIVER: undefined,
  GITHUB_APP_ID: undefined,
  GITHUB_APP_PRIVATE_KEY: undefined,
  SUPABASE_MANAGEMENT_TOKEN: undefined,
  VERCEL_TOKEN: undefined,
} satisfies Record<string, string | undefined>;

const CREDENTIALS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'SUPABASE_MANAGEMENT_TOKEN',
  'VERCEL_TOKEN',
] as const;

/** A real RSA PEM shape — the adversarial case for the `/your-/i` and `/dev_only/i` patterns. */
const REAL_PEM = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA'.repeat(4)}\n-----END RSA PRIVATE KEY-----`;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries({ ...REAL, ...overrides })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetServerEnvCache();
    fn();
  } finally {
    process.env = saved;
    __resetServerEnvCache();
  }
}

afterEach(() => __resetServerEnvCache());

describe('connector credential hygiene (production startup gate)', () => {
  it('boots with every connector credential ABSENT — fail-closed is a valid posture', () => {
    withEnv({}, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it.each(CREDENTIALS)('REFUSES to start when %s is a placeholder', (name) => {
    withEnv({ [name]: 'replace-me' }, () => {
      expect(() => serverEnv()).toThrow(new RegExp(name));
    });
    // Positive control: the identical env boots once the value is real, so the rejection is about
    // the placeholder and not about the variable merely being set.
    withEnv({ [name]: name === 'GITHUB_APP_PRIVATE_KEY' ? REAL_PEM : 'a-real-opaque-credential-value' }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it.each(['your-token-here', 'changeme', 'dev_only', 'token@example.com'])(
    'rejects the placeholder shape %s',
    (value) => {
      withEnv({ VERCEL_TOKEN: value }, () => {
        expect(() => serverEnv()).toThrow(/VERCEL_TOKEN/);
      });
    },
  );

  it('REFUSES a whitespace-only credential — truthy, so it defeats the fail-closed check', () => {
    withEnv({ VERCEL_TOKEN: '   ' }, () => {
      expect(() => serverEnv()).toThrow(/VERCEL_TOKEN \(whitespace-only/);
    });
  });

  it('treats an EMPTY credential as absent, matching the clients’ Boolean() check', () => {
    // isVercelConfigured() is Boolean(process.env.VERCEL_TOKEN): '' is falsy, so the connector is
    // already fail-closed and refusing to boot over it would be a pointless outage.
    withEnv({ VERCEL_TOKEN: '' }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it('does not flag a real PEM private key', () => {
    withEnv({ GITHUB_APP_ID: '4585078', GITHUB_APP_PRIVATE_KEY: REAL_PEM }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it('is PRODUCTION-only: a placeholder outside production is left alone', () => {
    withEnv({ NODE_ENV: 'development', VERCEL_TOKEN: 'replace-me' }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it('does NOT gate EXECUTORS_ENABLED — a bad allowlist entry fails closed on its own', () => {
    withEnv({ EXECUTORS_ENABLED: 'replace-me' }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });
});
