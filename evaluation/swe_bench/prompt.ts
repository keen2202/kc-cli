/**
 * SWE-bench prompt templates for KC-CLI
 */

import type { SWEBenchInstance } from './types';

/**
 * Build the system prompt for SWE-bench evaluation
 */
export function buildSystemPrompt(instance: SWEBenchInstance): string {
  return `You are KC-CLI, an expert software engineer specializing in debugging and fixing real-world issues in Python codebases.

Your task: Fix the GitHub issue described below by making minimal, targeted code changes.

REPOSITORY: ${instance.repo}
BASE COMMIT: ${instance.base_commit}

RULES:
1. Read and understand the issue description carefully
2. Explore the relevant source files to understand the codebase
3. Identify the root cause of the bug
4. Make the MINIMAL fix — change only what's necessary
5. Verify your fix by running the relevant tests
6. Generate a git diff patch as your final output

IMPORTANT CONSTRAINTS:
- Do NOT modify test files unless the issue specifically requires it
- Do NOT add new dependencies
- Do NOT refactor unrelated code
- Keep changes minimal and focused on the issue
- After fixing, run: git diff > /tmp/swe_patch.diff

When you're confident in your fix, generate the patch file and stop.`;
}

/**
 * Build the user prompt with the issue description
 */
export function buildUserPrompt(instance: SWEBenchInstance): string {
  return `## Issue

${instance.problem_statement}

## Task

Fix this issue in the \`${instance.repo}\` repository.

The repository has been cloned and checked out to the correct commit.
Explore the code, find the bug, fix it, then generate a patch with:

\`\`\`bash
git diff > /tmp/swe_patch.diff
\`\`\`

After generating the patch, you are done. Do not commit or push.`;
}

/**
 * Build a compact prompt for faster execution (token-saving mode)
 */
export function buildCompactPrompt(instance: SWEBenchInstance): string {
  return `Fix this bug. Repository: ${instance.repo}.

${instance.problem_statement}

After fixing, run: git diff > /tmp/swe_patch.diff`;
}
