/**
 * Structured logger with mandatory redaction. Deliberately dependency-free:
 * a logging library is one more package with network reach; this writes JSON
 * lines to stdout and nothing else.
 *
 * Redaction is not optional and not configurable at the call site — every
 * field value passes through `redact()` before serialization.
 */

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const SENSITIVE_KEYS = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'apikey',
  'api_key',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
]);

/** Known live-credential shapes. Applied to every string VALUE. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info') as Level;
  return LEVEL_RANK[configured] ?? LEVEL_RANK.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < minLevel()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: redactString(msg),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const log = {
  trace: (msg: string, fields?: Record<string, unknown>) => emit('trace', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** Exported for tests only. */
export const __testables = { redact, redactString };
