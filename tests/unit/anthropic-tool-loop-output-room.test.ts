import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, toolLoopRetryOutputTokens } from '@/providers/anthropic';
import { type ToolLoopEvent } from '@/types/provider';
import { OPS_CHAT_MAX_OUTPUT_TOKENS, opsChatClosingLine, opsChatCutOffLine } from '@/domain/opschat/limits';

/**
 * Hub prod 2026-10-23 (conversation seq 115/117/121): Ops Chat ran with a 1,500-token output limit on a thinking
 * model; on big turns (a pasted conversation + image, "do all 3") the call stopped at the limit having said nothing
 * — or mid tool call — and the owner saw "I couldn't finish that step" three times. Now: more room, ONE retry with
 * more room when a call hits the limit before saying anything, and an honest "ran out of room" when it still does.
 */

type Ev = Record<string, unknown>;
const start = (): Ev => ({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
const stop = (reason: string, out = 5): Ev => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: out } });
const textTurn = (text: string, reason = 'end_turn'): Ev[] => [
  start(),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  stop(reason),
];
/** Thinking used the whole budget: nothing said. */
const silentCutOff = (): Ev[] => [start(), stop('max_tokens', 8000)];
/** Cut off in the middle of a tool call's JSON. */
const toolCutOff = (): Ev[] => [
  start(),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_cut', name: 'propose_record_decision' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"title":"Server load 20 k' } },
  stop('max_tokens', 8000),
];

function rig(script: Ev[][]) {
  const budgets: number[] = [];
  let i = 0;
  const create = vi.fn(async (params: { max_tokens: number }) => {
    budgets.push(params.max_tokens);
    const events = script[Math.min(i, script.length - 1)]!;
    i++;
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
  const provider = new AnthropicProvider('test-key');
  (provider as unknown as { client: unknown }).client = { messages: { create } };
  const runTool = vi.fn(async () => '{"ok":true}');
  return { provider, create, budgets, runTool };
}

async function drain(it: AsyncIterable<ToolLoopEvent>) {
  const evs: ToolLoopEvent[] = [];
  for await (const e of it) evs.push(e);
  const text = evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
  const done = evs.at(-1) as Extract<ToolLoopEvent, { kind: 'done' }>;
  return { evs, text, done };
}

const REQ = { model: 'claude-sonnet-5', system: 's', turns: [{ role: 'user' as const, content: 'do all 3' }], temperature: 0.3, maxOutputTokens: OPS_CHAT_MAX_OUTPUT_TOKENS, timeoutMs: 1000 };
const TOOLS = [{ name: 'propose_record_decision', description: 'd', inputSchema: { type: 'object', properties: {} } }];

describe('Ops Chat tool loop — output room', () => {
  it('Ops Chat now gets 8,000 output tokens (was 1,500)', () => {
    expect(OPS_CHAT_MAX_OUTPUT_TOKENS).toBe(8_000);
  });

  it('hit the limit before saying anything → retried ONCE with more room; the answer comes through', async () => {
    const { provider, create, budgets } = rig([silentCutOff(), textTurn('All three are prepared below.')]);
    const { text, done } = await drain(provider.streamWithTools(REQ, TOOLS, vi.fn()));
    expect(create).toHaveBeenCalledTimes(2);
    expect(budgets).toEqual([8_000, 16_000]);
    expect(text).toBe('All three are prepared below.');
    expect(done).toMatchObject({ kind: 'done', cutOff: false, roomRetried: true });
    expect(done.usage.outputTokens).toBe(8_000 + 5); // both calls counted
  });

  it('cut off mid tool call → the partial tool call is NEVER run; retried with more room', async () => {
    const { provider, budgets, runTool } = rig([toolCutOff(), textTurn('Done.')]);
    await drain(provider.streamWithTools(REQ, TOOLS, runTool));
    expect(runTool).not.toHaveBeenCalled();
    expect(budgets).toEqual([8_000, 16_000]);
  });

  it('cut off again after the retry → the turn ends flagged cutOff (no third call, no wrap-up guess)', async () => {
    const { provider, create, runTool } = rig([silentCutOff(), silentCutOff(), textTurn('never reached')]);
    const { text, done } = await drain(provider.streamWithTools(REQ, TOOLS, runTool));
    expect(create).toHaveBeenCalledTimes(2);
    expect(runTool).not.toHaveBeenCalled();
    expect(text).toBe('');
    expect(done).toMatchObject({ cutOff: true, roomRetried: true, stopReason: 'max_tokens' });
  });

  it('cut off AFTER words were shown → not retried (no duplicated text), flagged cutOff', async () => {
    const { provider, create } = rig([textTurn('Here is the first part of the plan…', 'max_tokens')]);
    const { text, done } = await drain(provider.streamWithTools(REQ, TOOLS, vi.fn()));
    expect(create).toHaveBeenCalledTimes(1);
    expect(text).toBe('Here is the first part of the plan…');
    expect(done).toMatchObject({ cutOff: true, roomRetried: false });
  });

  it('retry budget: double, at least 16,000, at most 32,000', () => {
    expect(toolLoopRetryOutputTokens(1_500)).toBe(16_000);
    expect(toolLoopRetryOutputTokens(8_000)).toBe(16_000);
    expect(toolLoopRetryOutputTokens(12_000)).toBe(24_000);
    expect(toolLoopRetryOutputTokens(20_000)).toBe(32_000);
  });

  it('the owner is told what actually happened — never "couldn\'t finish that step" for a cut-off', () => {
    expect(opsChatCutOffLine(0, false)).toMatch(/ran out of room before I could write it\. Nothing was created or sent/);
    expect(opsChatCutOffLine(0, true)).toMatch(/ran out of room before I finished/);
    expect(opsChatCutOffLine(2, true)).toMatch(/nothing happens until you click Confirm/);
    expect(opsChatCutOffLine(0, false)).not.toBe(opsChatClosingLine(0));
  });
});
