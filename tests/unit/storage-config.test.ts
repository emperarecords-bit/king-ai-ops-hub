import { afterEach, describe, expect, it } from 'vitest';
import { __resetServerEnvCache, serverEnv } from '@/lib/env.server';

/**
 * O-23 Step 2 — production startup must REJECT an invalid cloud-storage config,
 * so the Library never appears to work while silently losing files.
 */

const REAL = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app_server:a-real-strong-pw@db.internal:5432/king_ai_hub',
  OPENAI_API_KEY: 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789',
  ANTHROPIC_API_KEY: 'sk-ant-live-abcdefghijklmnopqrstuvwxyz0123456789',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  NEXT_PUBLIC_SUPABASE_URL: 'https://real-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
};

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

describe('storage config production gate', () => {
  it('boots when STORAGE_DRIVER is unset (local default) with otherwise valid config', () => {
    withEnv({ STORAGE_DRIVER: undefined }, () => {
      expect(() => serverEnv()).not.toThrow();
    });
  });

  it('REFUSES to start when STORAGE_DRIVER=s3 but S3_* config is missing', () => {
    withEnv({ STORAGE_DRIVER: 's3', S3_ENDPOINT: undefined, S3_BUCKET: undefined }, () => {
      expect(() => serverEnv()).toThrow(/S3_/);
    });
  });

  it('boots when STORAGE_DRIVER=s3 and all S3_* are present and non-placeholder', () => {
    withEnv(
      {
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://fly.storage.tigris.dev',
        S3_REGION: 'auto',
        S3_BUCKET: 'king-ai-hub-library',
        S3_ACCESS_KEY_ID: 'AKIAREALKEYID',
        S3_SECRET_ACCESS_KEY: 'a-real-secret-value-not-a-placeholder',
      },
      () => {
        expect(() => serverEnv()).not.toThrow();
      },
    );
  });

  it('REFUSES a placeholder S3 secret in production', () => {
    withEnv(
      {
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'https://fly.storage.tigris.dev',
        S3_REGION: 'auto',
        S3_BUCKET: 'king-ai-hub-library',
        S3_ACCESS_KEY_ID: 'AKIAREALKEYID',
        S3_SECRET_ACCESS_KEY: 'your-secret-here', // matches /your-/ placeholder
      },
      () => {
        expect(() => serverEnv()).toThrow(/S3_SECRET_ACCESS_KEY/);
      },
    );
  });
});
