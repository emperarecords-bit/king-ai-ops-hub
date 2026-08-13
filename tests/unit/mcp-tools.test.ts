import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_SCOPES,
  MCP_READ_TOOLS,
  MCP_TOOL_NAMES,
  MCP_WRITE_TOOLS,
  isMcpToolName,
  isWriteTool,
} from '@/domain/mcp/tool-names';
import { MCP_TOOLS, getToolDefinition } from '@/domain/mcp/tools';

describe('mcp tool surface', () => {
  it('exposes exactly the four read and two write tools', () => {
    expect([...MCP_READ_TOOLS]).toEqual(['list_projects', 'get_task', 'search_messages', 'get_usage']);
    expect([...MCP_WRITE_TOOLS]).toEqual(['create_task', 'submit_run']);
    expect(MCP_TOOLS).toHaveLength(6);
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('new tokens default to read-only scope', () => {
    expect([...DEFAULT_TOKEN_SCOPES]).toEqual([...MCP_READ_TOOLS]);
    for (const s of DEFAULT_TOKEN_SCOPES) expect(isWriteTool(s)).toBe(false);
  });

  it('every tool publishes an object JSON Schema and is retrievable by name', () => {
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema).toMatchObject({ type: 'object' });
      expect(getToolDefinition(t.name)).toBe(t);
      expect(typeof t.handler).toBe('function');
    }
    expect(getToolDefinition('nope')).toBeUndefined();
  });

  it('exposes NO tool that approves, executes, or deploys — writes can only queue work', () => {
    // The approval queue is the only path to a side effect. An MCP token must never be able to approve or
    // execute; it can create a task and enqueue a run, both of which still land in that queue.
    for (const name of MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/approve|execute|deploy|delete|purge/i);
    }
  });

  it('isMcpToolName guards unknown names', () => {
    expect(isMcpToolName('get_task')).toBe(true);
    expect(isMcpToolName('drop_tables')).toBe(false);
  });
});
