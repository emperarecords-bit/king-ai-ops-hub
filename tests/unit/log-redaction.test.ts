import { describe, expect, it } from 'vitest';
import { __testables } from '@/lib/log';

const { redact, redactString } = __testables;

describe('log redaction', () => {
  it('redacts OpenAI-style keys in values', () => {
    expect(redactString('key is sk-abc123def456ghi789jkl012')).not.toContain('sk-abc123');
  });

  it('redacts Anthropic-style keys in values', () => {
    expect(redactString('sk-ant-api03-verylongkeyvalue123')).not.toContain('api03');
  });

  it('redacts bearer tokens', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('redacts sensitive field names regardless of value', () => {
    const out = redact({ authorization: 'anything', nested: { password: 'hunter2' } }) as Record<
      string,
      unknown
    >;
    expect(out.authorization).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('leaves ordinary fields alone', () => {
    const out = redact({ taskId: 'abc', count: 3 }) as Record<string, unknown>;
    expect(out.taskId).toBe('abc');
    expect(out.count).toBe(3);
  });

  it('redacts inside error stacks', () => {
    const err = new Error('failed calling with sk-abc123def456ghi789jkl012');
    const out = redact(err) as { message: string };
    expect(out.message).not.toContain('sk-abc123def456');
  });
});
