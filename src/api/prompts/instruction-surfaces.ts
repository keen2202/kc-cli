// Instruction surfaces (harness-evolution T1 / H1)
// Declarative manifest of prompt instruction segments, ported from the
// Self-Harness `build_*` + prompt-middleware pattern:
//   - Static surfaces reproduce PromptBuilder's segments byte-equivalently.
//   - Conditional surfaces carry a runtime predicate and are appended by
//     QueryEngine as the LAST system segment (KV prefix-cache friendly),
//     gated by `promptSurfaces.conditionalInjection` (default OFF).

import type { ProviderCapabilities } from '../capabilities';
import type {
  PromptTemplate,
  TaskType,
  InstructionSurface,
  InstructionSurfaceRuntime,
} from './types';
import type { ToolDefinition } from '../../tools/protocol';
import { createPromptRecord } from '../../agp/adapters/prompt-adapter';
import type { ResourceRegistrationRecord } from '../../agp/protocol';
import type { ConversationContext } from './prompt-builder';

// ─── Static surface manifest (byte-equivalent to legacy PromptBuilder) ──────

/**
 * Format the tool list segment (moved verbatim from PromptBuilder so the
 * manifest and the builder share a single source of truth).
 */
export function formatToolList(tools: ToolDefinition[], capabilities: ProviderCapabilities): string {
  const toolDescriptions = tools
    .slice(0, capabilities.recommendedMaxTools)
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n');

  const extra = tools.length > capabilities.recommendedMaxTools
    ? `\n... and ${tools.length - capabilities.recommendedMaxTools} more tools`
    : '';

  return `Available tools:\n${toolDescriptions}${extra}`;
}

function getTaskPrompt(template: PromptTemplate, taskType: TaskType): string {
  switch (taskType) {
    case 'code-gen':
      return template.codeGen;
    case 'debugging':
      return template.debugging;
    case 'refactoring':
      return template.refactoring;
    case 'documentation':
      return template.documentation;
    case 'creative':
      return template.creative;
    case 'general':
    default:
      return '';
  }
}

/**
 * Build the ordered static surface manifest for a system prompt.
 *
 * Ordering and inclusion conditions replicate the legacy
 * `PromptBuilder.buildSystemPrompt` exactly: joining the built texts with
 * '\n\n' yields a byte-identical prompt (guarded by equivalence tests).
 */
export function buildStaticSurfaceManifest(
  template: PromptTemplate,
  capabilities: ProviderCapabilities,
  tools: ToolDefinition[],
  context: ConversationContext = {}
): InstructionSurface[] {
  const surfaces: InstructionSurface[] = [];

  // Base provider system prompt
  surfaces.push({
    name: 'base-system',
    category: 'bootstrap',
    evolvable: true,
    build: () => template.system,
  });

  // Capability-specific instructions
  if (capabilities.supportsThinking) {
    surfaces.push({
      name: 'capability-thinking',
      category: 'execution',
      evolvable: false,
      build: () => 'Use <thinking> tags for internal reasoning before taking action.',
    });
  }

  if (capabilities.supportsExtendedThinking) {
    surfaces.push({
      name: 'capability-extended-thinking',
      category: 'execution',
      evolvable: false,
      build: () => 'You can use extended thinking for complex problems.',
    });
  }

  surfaces.push({
    name: 'capability-tool-parallelism',
    category: 'execution',
    evolvable: false,
    build: () => capabilities.supportsParallelToolCalls
      ? 'You may call multiple independent tools in parallel when appropriate. Batch independent searches (Grep/Glob/FileRead) into one message instead of one-per-turn.'
      : 'Call tools one at a time. Wait for each result before making the next call.',
  });

  // Search-strategy instruction: keep document lookup from turning into long
  // Grep→Grep→Read chains (docs/specs/tool-search-efficiency-spec.md).
  surfaces.push({
    name: 'search-strategy',
    category: 'execution',
    evolvable: false,
    build: () =>
      'Search efficiently: prefer ONE Grep call with multiple "patterns" (or output_mode "files_with_matches") over several sequential searches; ' +
      'use Glob when you know the filename shape; FileRead only the specific files/ranges a match identified; ' +
      'and batch independent lookups as parallel tool calls when the provider allows it.',
  });

  // Planning phase instructions (always injected for structured workflow)
  if (template.planning) {
    surfaces.push({
      name: 'planning',
      category: 'execution',
      evolvable: true,
      build: () => template.planning as string,
    });
  }

  // Tool instructions
  if (tools.length > 0) {
    surfaces.push({
      name: 'tool-use',
      category: 'execution',
      evolvable: true,
      build: () => template.toolUse,
    });
    surfaces.push({
      name: 'tool-list',
      category: 'execution',
      evolvable: false,
      build: () => formatToolList(tools, capabilities),
    });
  }

  // Task-specific instructions
  if (context.taskType) {
    const taskPrompt = getTaskPrompt(template, context.taskType);
    if (taskPrompt) {
      surfaces.push({
        name: `task-${context.taskType}`,
        category: 'execution',
        evolvable: true,
        build: () => taskPrompt,
      });
    }
  }

  // Workspace context
  if (context.workspaceContext) {
    surfaces.push({
      name: 'workspace-context',
      category: 'bootstrap',
      evolvable: false,
      build: () => `Workspace context:\n${context.workspaceContext}`,
    });
  }

  // Additional instructions
  if (context.additionalInstructions) {
    surfaces.push({
      name: 'additional-instructions',
      category: 'execution',
      evolvable: false,
      build: () => context.additionalInstructions as string,
    });
  }

  // Language-specific build/test hints
  if (context.languageInfo) {
    const { language, buildCommands, testCommands, lintCommands } = context.languageInfo;
    surfaces.push({
      name: 'language-verification',
      category: 'verification',
      evolvable: true,
      build: () => {
        const hints: string[] = [`Project language: ${language}`];
        if (buildCommands.length > 0) hints.push(`Build: ${buildCommands.join(', ')}`);
        if (testCommands.length > 0) hints.push(`Test: ${testCommands.join(', ')}`);
        if (lintCommands.length > 0) hints.push(`Lint: ${lintCommands.join(', ')}`);
        hints.push('\nAlways verify your changes compile before considering the task complete.');
        hints.push('Run the appropriate test suite after making changes.');
        return hints.join('\n');
      },
    });
  }

  return surfaces;
}

/**
 * Compose the static manifest into the final system prompt string.
 * Byte-equivalent to the legacy PromptBuilder join.
 */
export function composeStaticSurfaces(surfaces: InstructionSurface[]): string {
  return surfaces.map(s => s.build()).join('\n\n');
}

// ─── Conditional surfaces (predicate-triggered, opt-in) ─────────────────────

/** Bootstrap surface — injected only on the first turn (no tool messages yet). */
export const BOOTSTRAP_FIRST_TURN_SURFACE: InstructionSurface = {
  name: 'bootstrap-first-turn',
  category: 'bootstrap',
  evolvable: true,
  predicate: runtime => runtime.isFirstTurn,
  build: () => [
    '## First-Turn Orientation',
    'Before acting: restate the goal in one sentence, identify the minimal set of files or commands needed, and check for existing project conventions.',
    'Prefer inspecting the project structure over guessing paths. Do not modify anything until you understand the relevant code.',
  ].join('\n'),
};

/** Failure-recovery surface — injected only when the last tool result errored. */
export const FAILURE_RECOVERY_SURFACE: InstructionSurface = {
  name: 'failure-recovery',
  category: 'failureRecovery',
  evolvable: true,
  predicate: runtime => runtime.lastToolResultHadError,
  build: () => [
    '## Failure Recovery',
    'The previous tool call failed. Before retrying:',
    '1. Read the error message carefully and identify the terminal cause (missing file, bad arguments, permission, environment).',
    '2. Do NOT repeat the same command with the same arguments — change your approach.',
    '3. If an expected file or artifact is missing, create it directly instead of searching further.',
    '4. If a dependency or toolchain is missing, verify it exists before invoking it again.',
  ].join('\n'),
};

/** All conditional surfaces, in injection order. */
export const CONDITIONAL_SURFACES: readonly InstructionSurface[] = [
  BOOTSTRAP_FIRST_TURN_SURFACE,
  FAILURE_RECOVERY_SURFACE,
];

/**
 * Minimal structural message shape used to derive the surface runtime,
 * avoiding a dependency on query/protocol (keeps api → query decoupled).
 */
export interface SurfaceRuntimeMessage {
  role: string;
  toolResults?: Array<{ isError?: boolean }>;
}

/**
 * Derive the per-turn runtime state from the conversation.
 * First turn == no tool message yet (Self-Harness bootstrap predicate).
 */
export function computeSurfaceRuntime(messages: readonly SurfaceRuntimeMessage[]): InstructionSurfaceRuntime {
  let hasToolMessage = false;
  let lastToolResultHadError = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') {
      if (!hasToolMessage) {
        // Most recent tool message decides the failure-recovery predicate.
        lastToolResultHadError = (m.toolResults ?? []).some(r => r.isError === true);
      }
      hasToolMessage = true;
      break;
    }
  }
  return { isFirstTurn: !hasToolMessage, lastToolResultHadError };
}

/**
 * Build the conditional injection text for the current runtime state.
 * Returns '' when no surface predicate matches (nothing to inject).
 */
export function buildConditionalInjection(
  runtime: InstructionSurfaceRuntime,
  surfaces: readonly InstructionSurface[] = CONDITIONAL_SURFACES
): string {
  return surfaces
    .filter(s => s.predicate === undefined || s.predicate(runtime))
    .map(s => s.build(runtime))
    .filter(Boolean)
    .join('\n\n');
}

// ─── AGP registration bridge ─────────────────────────────────────────────────

/**
 * Convert evolvable instruction surfaces into AGP Prompt registration records
 * (via `createPromptRecord`), connecting PromptBuilder to the AGP registry.
 */
export function createSurfacePromptRecords(
  surfaces: readonly InstructionSurface[] = CONDITIONAL_SURFACES
): ResourceRegistrationRecord<'Prompt'>[] {
  return surfaces
    .filter(s => s.evolvable)
    .map(s => createPromptRecord({
      name: `instruction-surface-${s.name}`,
      description: `Instruction surface '${s.name}' (category: ${s.category})`,
      template: s.build({ isFirstTurn: true, lastToolResultHadError: true }),
      evolvability: 1,
      role: 'system',
    }));
}
