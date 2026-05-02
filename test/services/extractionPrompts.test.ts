import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt } from '../../src/services/extractionPrompts';

describe('buildExtractionPrompt', () => {
  it('should build prompt without existing memories', () => {
    const prompt = buildExtractionPrompt();
    expect(prompt).toContain('memory extraction assistant');
    expect(prompt).toContain('## Memory Type Guidelines');
    expect(prompt).toContain('### User (always private)');
    expect(prompt).toContain('### Feedback');
    expect(prompt).toContain('### Project');
    expect(prompt).toContain('### Reference');
    expect(prompt).toContain('## What NOT to save');
    expect(prompt).toContain('## Output Format');
    expect(prompt).not.toContain('## Existing Memories');
  });

  it('should include existing memories section when provided', () => {
    const prompt = buildExtractionPrompt('Existing memory content here');
    expect(prompt).toContain('## Existing Memories');
    expect(prompt).toContain('Existing memory content here');
    expect(prompt).toContain('Do not duplicate these memories.');
  });

  it('should handle empty string for existing memories', () => {
    const prompt = buildExtractionPrompt('');
    // Empty string is falsy, so no existing memories section
    expect(prompt).not.toContain('## Existing Memories');
  });

  it('should include frontmatter format example', () => {
    const prompt = buildExtractionPrompt();
    expect(prompt).toContain('---');
    expect(prompt).toContain('name: memory_name');
    expect(prompt).toContain('type: user|feedback|project|reference');
  });
});
