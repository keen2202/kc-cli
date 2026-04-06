// Ask User Tool - Interact with user for clarification

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';

const AskUserInputSchema = z.object({
  question: z.string().describe('Question to ask the user'),
  options: z.array(z.string()).optional().describe('Optional list of choices'),
  default_answer: z.string().optional().describe('Default answer if user provides none'),
});

type AskUserInput = z.infer<typeof AskUserInputSchema>;

export const tool = buildTool<AskUserInput, string>({
  name: 'AskUser',
  description: 'Ask the user for clarification or input',

  inputSchema: AskUserInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // In CLI mode, we can't actually prompt the user interactively
      // So we return the question for the orchestrator to handle
      let message = `User asked: ${input.question}`;

      if (input.options && input.options.length > 0) {
        message += '\n\nOptions:\n' + input.options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n');
      }

      if (input.default_answer) {
        message += `\n\nDefault: ${input.default_answer}`;
      }

      message += '\n\n[In interactive mode, user would be prompted here]';

      return toolResult(message, {
        metadata: {
          question: input.question,
          options_count: input.options?.length || 0,
          has_default: !!input.default_answer,
        },
      });
    } catch (error) {
      return toolError(`AskUser failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (): PermissionResult => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason: 'User interaction is safe' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Ask user questions with optional multiple choice.',

  getToolUseSummary: (input) => `Asking: ${input.question.slice(0, 50)}...`,
  getActivityDescription: (input) => 'Prompting user',
});
