// SQL Tool - Execute database queries

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';

const SqlInputSchema = z.object({
  query: z.string().describe('SQL query to execute'),
  database: z.string().describe('Database connection name or path'),
  params: z.array(z.unknown()).optional().describe('Query parameters'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

type SqlInput = z.infer<typeof SqlInputSchema>;

export const tool = buildTool<SqlInput, string>({
  name: 'Sql',
  description: 'Execute SQL database queries',

  inputSchema: SqlInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // Placeholder implementation - would integrate with actual database driver
      // For now, simulate query execution

      const queryLower = input.query.toLowerCase().trim();

      // Simulate different query types
      if (queryLower.startsWith('select')) {
        // Simulate SELECT query
        return toolResult(
          `Query executed successfully (simulated)\n\n` +
          `Database: ${input.database}\n` +
          `Query: ${input.query}\n\n` +
          `Results would appear here with actual database integration.\n` +
          `To enable: install appropriate database driver (sqlite3, pg, mysql2, etc.)`,
          {
            metadata: {
              database: input.database,
              query_type: 'SELECT',
              simulated: true,
            },
          }
        );
      } else if (queryLower.startsWith('insert') || queryLower.startsWith('update') || queryLower.startsWith('delete')) {
        return toolResult(
          `Write query would execute (simulated)\n\n` +
          `Database: ${input.database}\n` +
          `Query: ${input.query}\n\n` +
          `No rows affected (simulation mode).`,
          {
            metadata: {
              database: input.database,
              query_type: queryLower.split(' ')[0].toUpperCase(),
              simulated: true,
            },
          }
        );
      } else {
        return toolResult(
          `Query executed (simulated)\n\n` +
          `Database: ${input.database}\n` +
          `Query: ${input.query}`,
          {
            metadata: { database: input.database, simulated: true },
          }
        );
      }
    } catch (error) {
      return toolError(`SQL query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const queryLower = input.query.toLowerCase().trim();

    // Allow SELECT queries by default
    if (queryLower.startsWith('select') || queryLower.startsWith('show') || queryLower.startsWith('describe')) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Read-only SQL query' },
      };
    }

    // Ask for write operations
    return {
      behavior: 'ask',
      message: `Execute SQL: ${input.query.slice(0, 100)}...`,
    };
  },

  isReadOnly: (input) => {
    const queryLower = input.query.toLowerCase().trim();
    return queryLower.startsWith('select') || queryLower.startsWith('show') || queryLower.startsWith('describe');
  },
  isConcurrencySafe: () => true,
  isDestructive: (input) => {
    const queryLower = input.query.toLowerCase().trim();
    return queryLower.startsWith('delete') || queryLower.startsWith('drop') || queryLower.startsWith('truncate');
  },

  prompt: () => 'Execute SQL queries. SELECT is auto-allowed.',

  getToolUseSummary: (input) => `SQL: ${input.query.slice(0, 80)}...`,
  getActivityDescription: (input) => `Querying database`,
});
