import 'server-only';
import { z } from 'zod';

/**
 * The ONLY module allowed to read secret environment variables. It imports
 * `server-only`, so any import chain that reaches a Client Component fails the
 * build — that is invariant I2 (ARCHITECTURE.md §2), not a convenience.
 *
 * Validation happens once, lazily, so that importing this module in a test
 * without a full env does not explode until a value is actually needed.
 */

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'APP_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded',
    }),
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  RATE_LIMIT_RUNS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  DEFAULT_MONTHLY_SPEND_LIMIT_MICROS: z.coerce.bigint().positive().default(25_000_000n),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Deliberately list only the variable NAMES, never values.
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Server environment invalid or incomplete: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam. Not exported from any barrel; imported only by tests. */
export function __resetServerEnvCache(): void {
  cached = null;
}
