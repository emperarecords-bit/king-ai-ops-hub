import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '@/providers/anthropic';
import { type ToolLoopEvent } from '@/types/provider';

/**
 * The Ops Chat tool loop must never end a turn on a tool result with nothing said after it — the
 * owner just sees the conversation stop (seen live: "Let me try preparing the send card anyway…",
 * the send tool refused, and nothing followed). If tools ran and the model then hits the round cap
 * or answers with no text, the loop makes ONE extra call with tools disabled (tool_choice none) and
 * a nudge, so the model replies in words. The Anthropic client is a scripted fake: no network.
 */

type Ev = Record<string, unknown>;
const start = (): Ev => ({ type: 'message_start', message: { usage: { input_tokens: 1 } } });
const stop = (reason: string): Ev => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } });
const textTurn = (text: string): Ev[] => [
  start(),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  stop('end_turn'),
];
const emptyTurn = (): Ev[] => [start(), stop('end_turn')];
let toolSeq = 0;
const toolTurn = (name = 'propose_accuratebids_send'): Ev[] => [
  start(),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu_${++toolSeq}`, name } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"send":"invoice"}' } },
  stop('tool_use'),
];

function rig(script: Ev[][]) {
  const calls: { tool_choice?: unknown; lastUser: unknown }[] = [];
  let i = 0;
  const create = vi.fn(async (params: { tool_choice?: unknown; messages: { role: string; content: unknown }[] }) => {
    const last = params.messages[params.messages.length - 1];
    calls.push({ tool_choice: params.tool_choice, lastUser: JSON.parse(JSON.stringify(last?.content ?? null)) });
    const events = script[Math.min(i, script.length - 1)]!;
    i++;
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
  const provider = new AnthropicProvider('test-key');
  (provider as unknown as { client: unknown }).client = { messages: { create } };
  const runTool = vi.fn(async () => JSON.stringify({ error: 'That invoice has no customer email on file.' }));
  return { provider, create, calls, runTool };
}

async function drain(it: AsyncIterable<ToolLoopEvent>) {
  const evs: ToolLoopEvent[] = [];
  for await (const e of it) evs.push(e);
  const text = evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
  return { evs, text };
}

const REQ = { model: 'claude-sonnet-5', system: 's', turns: [{ role: 'user' as const, content: 'send it' }], temperature: 0.3, maxOutputTokens: 100, timeoutMs: 1000 };
const TOOLS = [{ name: 'propose_accuratebids_send', description: 'd', inputSchema: { type: 'object', properties: {} } }];

describe('Anthropic tool loop — a turn always ends with a reply', () => {
  it('tool refused, then an EMPTY answer → one tools-disabled wrap-up call that produces words', async () => {
    const { provider, create, calls, runTool } = rig([toolTurn(), emptyTurn(), textTurn('The send was refused: the invoice has no email. What is the address?')]);
    const { evs, text } = await drain(provider.streamWithTools(REQ, TOOLS, runTool));
    expect(create).toHaveBeenCalledTimes(3);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(calls[0]!.tool_choice).toBeUndefined();
    expect(calls[1]!.tool_choice).toBeUndefined();
    expect(calls[2]!.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(calls[2]!.lastUser)).toMatch(/Reply to the owner now in plain words/);
    expect(text).toMatch(/refused/);
    expect(evs.at(-1)!.kind).toBe('done');
  });

  it('hitting the tool-round cap right after a tool round → a wrap-up call instead of silence', async () => {
    const script = [...Array.from({ length: 6 }, () => toolTurn()), textTurn('I tried six times; here is what blocked me.')];
    const { provider, create, calls, runTool } = rig(script);
    const { text } = await drain(provider.streamWithTools(REQ, TOOLS, runTool));
    expect(runTool).toHaveBeenCalledTimes(6);
    expect(create).toHaveBeenCalledTimes(7);
    expect(calls[6]!.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(calls[6]!.lastUser)).toMatch(/Tool-round limit reached/);
    expect(text).toMatch(/what blocked me/);
  });

  it('an empty answer on the LAST allowed round still gets its wrap-up call', async () => {
    const script = [...Array.from({ length: 5 }, () => toolTurn()), emptyTurn(), textTurn('Here is where things stand.')];
    const { provider, create, calls } = rig(script);
    const { text } = await drain(provider.streamWithTools(REQ, TOOLS, vi.fn(async () => '{}')));
    expect(create).toHaveBeenCalledTimes(7);
    expect(calls[6]!.tool_choice).toEqual({ type: 'none' });
    expect(text).toMatch(/where things stand/);
  });

  it('a normal tool → answer turn makes no extra call', async () => {
    const { provider, create, calls } = rig([toolTurn(), textTurn('Card is ready below.')]);
    const { text } = await drain(provider.streamWithTools(REQ, TOOLS, vi.fn(async () => '{"prepared":true}')));
    expect(create).toHaveBeenCalledTimes(2);
    expect(calls.every((c) => c.tool_choice === undefined)).toBe(true);
    expect(text).toBe('Card is ready below.');
  });

  it('a plain answer with no tools makes exactly one call, and an empty no-tool answer is not retried here', async () => {
    const a = rig([textTurn('Hi.')]);
    await drain(a.provider.streamWithTools(REQ, TOOLS, a.runTool));
    expect(a.create).toHaveBeenCalledTimes(1);
    const b = rig([emptyTurn()]);
    await drain(b.provider.streamWithTools(REQ, TOOLS, b.runTool));
    expect(b.create).toHaveBeenCalledTimes(1); // the route's closing line covers this case
  });

  it('the wrap-up is attempted ONCE: if it is empty too, the loop still ends (bounded)', async () => {
    const { provider, create } = rig([toolTurn(), emptyTurn(), emptyTurn(), textTurn('never reached')]);
    const { evs, text } = await drain(provider.streamWithTools(REQ, TOOLS, vi.fn(async () => '{}')));
    expect(create).toHaveBeenCalledTimes(3);
    expect(text).toBe('');
    expect(evs.at(-1)!.kind).toBe('done');
  });

  it('a wrap-up that still asks for a tool never runs it', async () => {
    const script = [...Array.from({ length: 6 }, () => toolTurn()), toolTurn()];
    const runTool = vi.fn(async () => '{}');
    const { provider, create } = rig(script);
    await drain(provider.streamWithTools(REQ, TOOLS, runTool));
    expect(create).toHaveBeenCalledTimes(7);
    expect(runTool).toHaveBeenCalledTimes(6);
  });
});
