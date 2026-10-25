import { describe, expect, it, vi } from 'vitest';
import { APIError } from 'openai';
import { OpenAIProvider } from '@/providers/openai';
import { ProviderError } from '@/types/provider';

/**
 * 2026-10-22 — the Council moved to gpt-5.4. OpenAI's reasoning models accept only the default temperature; the
 * adapter now learns that the way the Anthropic adapter does (one retry without `temperature`, then remembered).
 */

const COMPLETION = {
  model: 'gpt-5.4',
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

function rejectTemperature(): APIError {
  return new APIError(
    400,
    { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." },
    "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
    new Headers(),
  );
}

function withFakeClient(create: ReturnType<typeof vi.fn>): OpenAIProvider {
  const p = new OpenAIProvider('test-key-not-real');
  (p as unknown as { client: unknown }).client = { chat: { completions: { create } } };
  return p;
}

const REQ = { model: 'gpt-5.4', system: 's', turns: [{ role: 'user' as const, content: 'u' }], temperature: 0.2, maxOutputTokens: 100, timeoutMs: 1000 };

describe('OpenAI adapter — temperature fallback', () => {
  it('a "temperature unsupported" 400 is retried once without temperature, then remembered for that model', async () => {
    const create = vi.fn().mockRejectedValueOnce(rejectTemperature()).mockResolvedValue(COMPLETION);
    const p = withFakeClient(create);

    const r1 = await p.execute(REQ);
    expect(r1.text).toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0]).toHaveProperty('temperature', 0.2);
    expect(create.mock.calls[1]![0]).not.toHaveProperty('temperature');

    await p.execute(REQ); // remembered: no failed first attempt this time
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2]![0]).not.toHaveProperty('temperature');
  });

  it('other models still send temperature; other 400s are not retried', async () => {
    const other = new APIError(400, { message: 'Invalid messages' }, 'Invalid messages', new Headers());
    const create = vi.fn().mockRejectedValue(other);
    const p = withFakeClient(create);

    await expect(p.execute({ ...REQ, model: 'gpt-5.4-mini' })).rejects.toBeInstanceOf(ProviderError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toHaveProperty('temperature', 0.2);
  });
});
