// Tests for instruction surfaces (harness-evolution T1 / H1)
// Guards: (1) byte-equivalence of the static manifest vs the legacy inline
// composition, (2) conditional surface predicates, (3) AGP registration.

import { describe, it, expect } from 'vitest';
import {
  buildStaticSurfaceManifest,
  composeStaticSurfaces,
  formatToolList,
  computeSurfaceRuntime,
  buildConditionalInjection,
  createSurfacePromptRecords,
  BOOTSTRAP_FIRST_TURN_SURFACE,
  FAILURE_RECOVERY_SURFACE,
  CONDITIONAL_SURFACES,
} from '../../src/api/prompts/instruction-surfaces';
import { PromptBuilder } from '../../src/api/prompts/prompt-builder';
import type { ConversationContext } from '../../src/api/prompts/prompt-builder';
import { PROVIDER_PROMPTS } from '../../src/api/prompts/provider-prompts';
import { getCapabilities } from '../../src/api/capabilities';
import type { ProviderCapabilities } from '../../src/api/capabilities';
import type { PromptTemplate, TaskType } from '../../src/api/prompts/types';
import type { ToolDefinition } from '../../src/tools/protocol';

// ─── Legacy composition (verbatim port of the pre-T1 PromptBuilder) ─────────

function legacyBuildSystemPrompt(
  template: PromptTemplate,
  capabilities: ProviderCapabilities,
  tools: ToolDefinition[],
  context: ConversationContext = {}
): string {
  const sections: string[] = [];

  sections.push(template.system);

  if (capabilities.supportsThinking) {
    sections.push('Use <thinking> tags for internal reasoning before taking action.');
  }
  if (capabilities.supportsExtendedThinking) {
    sections.push('You can use extended thinking for complex problems.');
  }
  sections.push(
    capabilities.supportsParallelToolCalls
      ? 'You may call multiple independent tools in parallel when appropriate.'
      : 'Call tools one at a time. Wait for each result before making the next call.'
  );

  if (template.planning) {
    sections.push(template.planning);
  }

  if (tools.length > 0) {
    sections.push(template.toolUse);
    sections.push(formatToolList(tools, capabilities));
  }

  if (context.taskType) {
    const taskPrompts: Record<string, string> = {
      'code-gen': template.codeGen,
      debugging: template.debugging,
      refactoring: template.refactoring,
      documentation: template.documentation,
      creative: template.creative,
      general: '',
    };
    const taskPrompt = taskPrompts[context.taskType] ?? '';
    if (taskPrompt) sections.push(taskPrompt);
  }

  if (context.workspaceContext) {
    sections.push(`Workspace context:\n${context.workspaceContext}`);
  }
  if (context.additionalInstructions) {
    sections.push(context.additionalInstructions);
  }

  if (context.languageInfo) {
    const { language, buildCommands, testCommands, lintCommands } = context.languageInfo;
    const hints: string[] = [`Project language: ${language}`];
    if (buildCommands.length > 0) hints.push(`Build: ${buildCommands.join(', ')}`);
    if (testCommands.length > 0) hints.push(`Test: ${testCommands.join(', ')}`);
    if (lintCommands.length > 0) hints.push(`Lint: ${lintCommands.join(', ')}`);
    hints.push('\nAlways verify your changes compile before considering the task complete.');
    hints.push('Run the appropriate test suite after making changes.');
    sections.push(hints.join('\n'));
  }

  return sections.join('\n\n');
}

const SAMPLE_TOOLS = [
  { name: 'Bash', description: 'Run shell commands', inputSchema: {} },
  { name: 'FileRead', description: 'Read files', inputSchema: {} },
] as ToolDefinition[];

const MANY_TOOLS = Array.from({ length: 12 }, (_, i) => ({
  name: `Tool${i}`,
  description: `Tool ${i} description`,
  inputSchema: {},
})) as ToolDefinition[];

const CONTEXT_VARIANTS: ConversationContext[] = [
  {},
  { taskType: 'debugging' as TaskType },
  { taskType: 'general' as TaskType },
  { workspaceContext: 'TypeScript monorepo with vitest.' },
  { additionalInstructions: 'Prefer minimal diffs.' },
  {
    taskType: 'code-gen' as TaskType,
    workspaceContext: 'CLI project',
    additionalInstructions: 'Follow strict mode.',
    languageInfo: {
      language: 'typescript',
      buildCommands: ['npm run build'],
      testCommands: ['npm test'],
      lintCommands: [],
    },
  },
];

describe('instruction surfaces (T1)', () => {
  describe('static manifest byte-equivalence', () => {
    const providers = ['anthropic', 'openai', 'ollama', 'deepseek', 'unknown'];

    for (const provider of providers) {
      it(`matches legacy composition byte-for-byte for provider '${provider}'`, () => {
        const caps = getCapabilities(provider);
        const template = PROVIDER_PROMPTS[provider] ?? PROVIDER_PROMPTS['default'];

        for (const tools of [[], SAMPLE_TOOLS, MANY_TOOLS]) {
          for (const context of CONTEXT_VARIANTS) {
            const legacy = legacyBuildSystemPrompt(template, caps, tools, context);
            const manifest = composeStaticSurfaces(
              buildStaticSurfaceManifest(template, caps, tools, context)
            );
            expect(manifest).toBe(legacy);
          }
        }
      });
    }

    it('PromptBuilder.buildSystemPrompt delegates to the manifest (equivalence)', () => {
      const caps = getCapabilities('anthropic');
      const builder = new PromptBuilder('anthropic', caps);
      const template = PROVIDER_PROMPTS['anthropic'];

      const viaBuilder = builder.buildSystemPrompt(SAMPLE_TOOLS, { taskType: 'refactoring' });
      const viaLegacy = legacyBuildSystemPrompt(template, caps, SAMPLE_TOOLS, { taskType: 'refactoring' });
      expect(viaBuilder).toBe(viaLegacy);
    });
  });

  describe('conditional surface predicates', () => {
    it('bootstrap surface fires only on the first turn (no tool messages)', () => {
      expect(BOOTSTRAP_FIRST_TURN_SURFACE.predicate!({ isFirstTurn: true, lastToolResultHadError: false })).toBe(true);
      expect(BOOTSTRAP_FIRST_TURN_SURFACE.predicate!({ isFirstTurn: false, lastToolResultHadError: false })).toBe(false);
    });

    it('failure-recovery surface fires only after an errored tool result', () => {
      expect(FAILURE_RECOVERY_SURFACE.predicate!({ isFirstTurn: false, lastToolResultHadError: true })).toBe(true);
      expect(FAILURE_RECOVERY_SURFACE.predicate!({ isFirstTurn: false, lastToolResultHadError: false })).toBe(false);
    });

    it('computeSurfaceRuntime: no messages → first turn, no error', () => {
      expect(computeSurfaceRuntime([])).toEqual({ isFirstTurn: true, lastToolResultHadError: false });
    });

    it('computeSurfaceRuntime: user/assistant only → still first turn', () => {
      const runtime = computeSurfaceRuntime([
        { role: 'user' },
        { role: 'assistant' },
      ]);
      expect(runtime.isFirstTurn).toBe(true);
      expect(runtime.lastToolResultHadError).toBe(false);
    });

    it('computeSurfaceRuntime: successful tool message → not first turn, no error', () => {
      const runtime = computeSurfaceRuntime([
        { role: 'user' },
        { role: 'assistant' },
        { role: 'tool', toolResults: [{ isError: false }] },
      ]);
      expect(runtime).toEqual({ isFirstTurn: false, lastToolResultHadError: false });
    });

    it('computeSurfaceRuntime: most recent tool message errored → failure recovery', () => {
      const runtime = computeSurfaceRuntime([
        { role: 'tool', toolResults: [{ isError: false }] },
        { role: 'assistant' },
        { role: 'tool', toolResults: [{ isError: true }] },
      ]);
      expect(runtime).toEqual({ isFirstTurn: false, lastToolResultHadError: true });
    });

    it('computeSurfaceRuntime: earlier error superseded by later success → no error', () => {
      const runtime = computeSurfaceRuntime([
        { role: 'tool', toolResults: [{ isError: true }] },
        { role: 'assistant' },
        { role: 'tool', toolResults: [{ isError: false }] },
      ]);
      expect(runtime).toEqual({ isFirstTurn: false, lastToolResultHadError: false });
    });
  });

  describe('buildConditionalInjection', () => {
    it('injects bootstrap surface on first turn', () => {
      const text = buildConditionalInjection({ isFirstTurn: true, lastToolResultHadError: false });
      expect(text).toContain('First-Turn Orientation');
      expect(text).not.toContain('Failure Recovery');
    });

    it('injects failure-recovery surface after an error', () => {
      const text = buildConditionalInjection({ isFirstTurn: false, lastToolResultHadError: true });
      expect(text).toContain('Failure Recovery');
      expect(text).not.toContain('First-Turn Orientation');
    });

    it('returns empty string when no predicate matches', () => {
      const text = buildConditionalInjection({ isFirstTurn: false, lastToolResultHadError: false });
      expect(text).toBe('');
    });
  });

  describe('AGP registration bridge', () => {
    it('creates Prompt records for evolvable conditional surfaces', () => {
      const records = createSurfacePromptRecords();
      const evolvableCount = CONDITIONAL_SURFACES.filter(s => s.evolvable).length;
      expect(records).toHaveLength(evolvableCount);
      for (const record of records) {
        expect(record.entity.name).toMatch(/^instruction-surface-/);
        expect(record.entity.evolvability).toBe(1);
        expect(record.version).toBeTruthy();
      }
    });

    it('skips non-evolvable surfaces', () => {
      const records = createSurfacePromptRecords([
        { ...BOOTSTRAP_FIRST_TURN_SURFACE, evolvable: false },
      ]);
      expect(records).toHaveLength(0);
    });
  });
});
