import { describe, it, expect } from 'vitest';
import { buildConsolidationPrompt, buildMergePrompt } from '../../src/services/consolidationPrompts';

describe('buildConsolidationPrompt', () => {
  it('should build consolidation prompt with orient results and insights', () => {
    const prompt = buildConsolidationPrompt('orient data', 'insight data');
    expect(prompt).toContain('memory consolidation assistant');
    expect(prompt).toContain('orient data');
    expect(prompt).toContain('insight data');
    expect(prompt).toContain('Four-Stage Process');
    expect(prompt).toContain('Stage 1: ORIENT');
    expect(prompt).toContain('Stage 2: COLLECT');
    expect(prompt).toContain('Stage 3: INTEGRATE');
    expect(prompt).toContain('Stage 4: TRIM');
  });

  it('should include memory type guidelines', () => {
    const prompt = buildConsolidationPrompt('', '');
    expect(prompt).toContain('**user**');
    expect(prompt).toContain('**feedback**');
    expect(prompt).toContain('**project**');
    expect(prompt).toContain('**reference**');
  });

  it('should include output format instructions', () => {
    const prompt = buildConsolidationPrompt('', '');
    expect(prompt).toContain('ACTION: CREATE|UPDATE|DELETE|MERGE');
    expect(prompt).toContain('FILE: filename.md');
  });
});

describe('buildMergePrompt', () => {
  it('should build merge prompt with memory list', () => {
    const memories = [
      { name: 'memory1', content: 'Content of memory 1' },
      { name: 'memory2', content: 'Content of memory 2' },
    ];
    const prompt = buildMergePrompt(memories);
    expect(prompt).toContain('Memory 1: memory1');
    expect(prompt).toContain('Content of memory 1');
    expect(prompt).toContain('Memory 2: memory2');
    expect(prompt).toContain('Content of memory 2');
    expect(prompt).toContain('YAML frontmatter format');
  });

  it('should handle single memory', () => {
    const prompt = buildMergePrompt([{ name: 'solo', content: 'alone' }]);
    expect(prompt).toContain('Memory 1: solo');
    expect(prompt).not.toContain('Memory 2');
  });

  it('should handle empty memories array', () => {
    const prompt = buildMergePrompt([]);
    expect(prompt).toContain('appear to be related');
  });
});
