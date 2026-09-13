// T28 (M3): system-prompt sections are shared, not duplicated — round4 §6-M3
// AGP adapter surface was removed in experiment-runtime T13; this file now
// guards the bootstrap path only.

import { describe, it, expect, beforeEach } from 'vitest';
import { GUIDELINES_SECTION, CAPABILITIES_SECTION } from '../../src/api/prompts/system-prompt-sections';
import { buildSystemPrompt } from '../../src/bootstrap/Bootstrap';
import { initializeState } from '../../src/bootstrap/state';
import type { ToolDefinition } from '../../src/tools/protocol';

beforeEach(() => {
  initializeState({
    cwd: '/tmp',
    projectRoot: null,
    sessionId: 't28',
    permissionMode: 'default',
    verbose: false,
    printMode: false,
    bareMode: false,
    maxTurns: null,
    maxBudgetUsd: null,
    config: null,
  });
});

describe('T28: shared system-prompt sections', () => {
  it('exports stable, non-empty sections', () => {
    expect(GUIDELINES_SECTION).toContain('Guidelines:');
    expect(GUIDELINES_SECTION).toContain('6. Follow best practices for code quality and security');
    expect(CAPABILITIES_SECTION).toContain('Available capabilities:');
    expect(CAPABILITIES_SECTION).toContain('- Compile, test, and run programs');
  });

  it('bootstrap renders the shared sections', () => {
    const bootstrapPrompt = buildSystemPrompt([] as ToolDefinition[]);
    expect(bootstrapPrompt).toContain(GUIDELINES_SECTION);
    expect(bootstrapPrompt).toContain(CAPABILITIES_SECTION);
  });

  it('bootstrap keeps its security block between the shared sections', () => {
    const prompt = buildSystemPrompt([] as ToolDefinition[]);
    const guidelinesEnd = prompt.indexOf(GUIDELINES_SECTION) + GUIDELINES_SECTION.length;
    const capabilitiesStart = prompt.indexOf(CAPABILITIES_SECTION);
    const middle = prompt.slice(guidelinesEnd, capabilitiesStart);
    expect(middle).toContain('Security — untrusted content (prompt-injection defense)');
  });
});
