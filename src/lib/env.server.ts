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
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().optional(),
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

// Values that must never reach production — placeholders from .env.example and
// obviously-fake secrets. In production these fail fast rather than boot with a
// broken or insecure config.
const PLACEHOLDER_PATTERNS = [/replace-me/i, /your-/i, /example\.com/i, /changeme/i, /dev_only/i, /^sk-\.\.\./i];

function assertProductionSafe(env: ServerEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const offenders: string[] = [];
  const check = (name: string, value: string) => {
    if (PLACEHOLDER_PATTERNS.some((re) => re.test(value))) offenders.push(name);
  };
  check('OPENAI_API_KEY', env.OPENAI_API_KEY);
  check('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
  check('APP_ENCRYPTION_KEY', env.APP_ENCRYPTION_KEY);
  check('DATABASE_URL', env.DATABASE_URL);
  // A superuser / dev password in the DB URL means RLS is not the enforced net.
  if (/:(king|postgres|app_server_dev_only)@/.test(env.DATABASE_URL)) {
    offenders.push('DATABASE_URL (must use the non-superuser app_server role in production)');
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder/insecure config: ${offenders.join(', ')}`,
    );
  }
}

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Deliberately list only the variable NAMES, never values.
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Server environment invalid or incomplete: ${missing}`);
  }
  assertProductionSafe(parsed.data);
  cached = parsed.data;
  return cached;
}

/** Test seam. Not exported from any barrel; imported only by tests. */
export function __resetServerEnvCache(): void {
  cached = null;
}
