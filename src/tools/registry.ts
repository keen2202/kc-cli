import type { ToolDefinition } from '../types/tools';

/**
 * Tool module convention interface.
 * Tool directories should export either:
 * - A `tool` export (ToolDefinition)
 * - A `register` function
 * - A default export (ToolDefinition)
 */
export interface ToolModule {
  tool?: ToolDefinition;
  register?: () => ToolDefinition;
  default?: ToolDefinition;
}
