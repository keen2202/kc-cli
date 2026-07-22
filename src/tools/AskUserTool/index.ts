// Ask User Tool - Interact with user for clarification

import * as readline from 'node:readline';
import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';

const AskUserInputSchema = z.object({
  question: z.string().describe('Question to ask the user'),
  options: z.array(z.string()).optional().describe('Optional list of choices'),
  default_answer: z.string().optional().describe('Default answer if user provides none'),
});

type AskUserInput = z.infer<typeof AskUserInputSchema>;

/** Build the prompt text shown for a blocking stdin read. */
function buildPrompt(question: string, options?: string[], defaultAnswer?: string): string {
  let prompt = question;
  if (options && options.length > 0) {
    prompt += '\n' + options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n');
  }
  if (defaultAnswer !== undefined) {
    prompt += `\n[default: ${defaultAnswer}]`;
  }
  prompt += '\n> ';
  return prompt;
}

/**
 * Resolve the user's answer from a raw stdin line: empty input falls back to
 * the default; a valid 1-based number selects the matching option; otherwise
 * the trimmed text is returned verbatim.
 */
function resolveAnswer(raw: string, options?: string[], defaultAnswer?: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' && defaultAnswer !== undefined) {
    return defaultAnswer;
  }
  if (options && options.length > 0) {
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1];
    }
  }
  return trimmed;
}

/** Blocking read from the TTY via node:readline. */
async function promptViaReadline(
  question: string,
  options?: string[],
  defaultAnswer?: string
): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await new Promise<string>((resolve) => {
      rl.question(buildPrompt(question, options, defaultAnswer), resolve);
    });
    return resolveAnswer(raw, options, defaultAnswer);
  } finally {
    rl.close();
  }
}

export const tool = buildTool<AskUserInput, string>({
  name: 'AskUser',
  description: 'Ask the user for clarification or input',

  inputSchema: AskUserInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    const { question, options, default_answer } = input;
    const metadata = {
      question,
      options_count: options?.length || 0,
      has_default: default_answer !== undefined,
    };

    try {
      // 1. Registered interaction handler (UI, or CLI stdin implementation).
      if (context.interaction) {
        const answer = await context.interaction.ask({
          question,
          options,
          default: default_answer,
        });
        return toolResult(answer, { metadata: { ...metadata, source: 'handler' } });
      }

      // 2. Interactive TTY without a handler → block on stdin.
      if (process.stdin.isTTY) {
        const answer = await promptViaReadline(question, options, default_answer);
        return toolResult(answer, { metadata: { ...metadata, source: 'stdin' } });
      }

      // 3. Non-interactive: use the provided default, else fail explicitly.
      if (default_answer !== undefined) {
        return toolResult(default_answer, { metadata: { ...metadata, source: 'default' } });
      }
      return toolError('interactive input unavailable');
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
  // Interactive reads block on IO and print prompts — never run concurrently
  // with other tools to avoid interleaving with streamed output.
  isConcurrencySafe: () => false,

  prompt: () => 'Ask user questions with optional multiple choice.',

  getToolUseSummary: (input) => `Asking: ${input.question.slice(0, 50)}...`,
  getActivityDescription: (input) => 'Prompting user',
});
