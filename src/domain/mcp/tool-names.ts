/**
 * The MCP tool surface (Phase 5). Read tools never mutate; write tools land in the SAME approval queue as the UI
 * and never bypass it (docs/architecture/mcp-server-decision.md). A token's `scopes` is a subset of these names;
 * the empty set permits nothing.
 */

export const MCP_READ_TOOLS = [
  'list_projects',
  'get_task',
  'search_messages',
  'get_usage',
  'list_position_templates',
] as const;
export const MCP_WRITE_TOOLS = ['create_task', 'submit_run', 'create_workspace', 'staff_positions'] as const;
export const MCP_TOOL_NAMES = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function isMcpToolName(value: string): value is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(value);
}

export function isWriteTool(name: McpToolName): boolean {
  return (MCP_WRITE_TOOLS as readonly string[]).includes(name);
}

/** New tokens are read-only unless the minter explicitly widens them. */
export const DEFAULT_TOKEN_SCOPES: readonly McpToolName[] = [...MCP_READ_TOOLS];
