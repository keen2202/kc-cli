import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseFrontmatter,
  generateFrontmatter,
  composeMemoryFile,
  parseMemoryFile,
  validateMemoryType,
} from '../../src/memory/frontmatter';
import type { MemoryHeader } from '../../src/memory/types';

describe('frontmatter', () => {
  describe('parseFrontmatter', () => {
    it('should parse valid YAML frontmatter', () => {
      const content = `---
name: test_memory
description: A test memory
type: user
createdAt: 1700000000000
updatedAt: 1700000000001
---
This is the body content.`;

      const result = parseFrontmatter(content);

      expect(result.header.name).toBe('test_memory');
      expect(result.header.description).toBe('A test memory');
      expect(result.header.type).toBe('user');
      expect(result.header.createdAt).toBe(1700000000000);
      expect(result.header.updatedAt).toBe(1700000000001);
      expect(result.body).toBe('This is the body content.');
    });

    it('should return empty header and full content when no frontmatter', () => {
      const content = 'Just some plain text without frontmatter.';
      const result = parseFrontmatter(content);

      expect(result.header).toEqual({});
      expect(result.body).toBe(content);
    });

    it('should handle frontmatter without trailing newline before closing delimiter', () => {
      const content = `---
name: test
type: project
---
Body here`;

      const result = parseFrontmatter(content);
      expect(result.header.name).toBe('test');
      expect(result.header.type).toBe('project');
      expect(result.body).toBe('Body here');
    });

    it('should handle empty body', () => {
      const content = `---
name: empty_body
type: reference
---
`;

      const result = parseFrontmatter(content);
      expect(result.header.name).toBe('empty_body');
      expect(result.body).toBe('');
    });

    it('should handle quoted YAML values', () => {
      const content = `---
name: "quoted name"
description: 'single quoted desc'
type: user
---
Content`;

      const result = parseFrontmatter(content);
      expect(result.header.name).toBe('quoted name');
      expect(result.header.description).toBe('single quoted desc');
    });

    it('should handle numeric values in YAML', () => {
      const content = `---
name: num_test
type: project
createdAt: 1234567890
updatedAt: 9876543210
---
Content`;

      const result = parseFrontmatter(content);
      expect(result.header.createdAt).toBe(1234567890);
      expect(result.header.updatedAt).toBe(9876543210);
    });

    it('should handle confidence field with valid values', () => {
      const contentLow = `---
name: low_conf
type: user
confidence: low
---
Body`;

      const contentHigh = `---
name: high_conf
type: user
confidence: high
---
Body`;

      expect(parseFrontmatter(contentLow).header.confidence).toBe('low');
      expect(parseFrontmatter(contentHigh).header.confidence).toBe('high');
    });

    it('should ignore invalid confidence values', () => {
      const content = `---
name: bad_conf
type: user
confidence: medium
---
Body`;

      const result = parseFrontmatter(content);
      expect(result.header.confidence).toBeUndefined();
    });

    it('should skip malformed YAML lines gracefully', () => {
      const content = `---
name: valid
this is not valid yaml
type: user
  indented badly
---
Body content`;

      const result = parseFrontmatter(content);
      expect(result.header.name).toBe('valid');
      expect(result.header.type).toBe('user');
      expect(result.body).toBe('Body content');
    });

    it('should handle unknown YAML keys without error', () => {
      const content = `---
name: test
type: user
unknownField: someValue
anotherUnknown: 123
---
Body`;

      const result = parseFrontmatter(content);
      expect(result.header.name).toBe('test');
      expect(result.header.type).toBe('user');
    });

    it('should handle completely empty content', () => {
      const result = parseFrontmatter('');
      expect(result.header).toEqual({});
      expect(result.body).toBe('');
    });

    it('should handle frontmatter with only opening delimiter (malformed)', () => {
      const content = `---
name: broken
type: user`;

      const result = parseFrontmatter(content);
      // No match because closing --- is missing
      expect(result.header).toEqual({});
      expect(result.body).toBe(content);
    });

    it('should trim body content', () => {
      const content = `---
name: trim_test
type: user
---

   Body with leading/trailing whitespace.

`;

      const result = parseFrontmatter(content);
      expect(result.body).toBe('Body with leading/trailing whitespace.');
    });
  });

  describe('validateMemoryType', () => {
    it('should accept valid types', () => {
      expect(validateMemoryType('user')).toBe('user');
      expect(validateMemoryType('feedback')).toBe('feedback');
      expect(validateMemoryType('project')).toBe('project');
      expect(validateMemoryType('reference')).toBe('reference');
    });

    it('should be case-insensitive', () => {
      expect(validateMemoryType('User')).toBe('user');
      expect(validateMemoryType('FEEDBACK')).toBe('feedback');
      expect(validateMemoryType('Project')).toBe('project');
    });

    it('should trim whitespace', () => {
      expect(validateMemoryType('  user  ')).toBe('user');
      expect(validateMemoryType(' reference ')).toBe('reference');
    });

    it('should return undefined for invalid types', () => {
      expect(validateMemoryType('invalid')).toBeUndefined();
      expect(validateMemoryType('')).toBeUndefined();
      expect(validateMemoryType('admin')).toBeUndefined();
      expect(validateMemoryType('system')).toBeUndefined();
    });
  });

  describe('generateFrontmatter', () => {
    it('should generate valid YAML frontmatter from a header', () => {
      const header: MemoryHeader = {
        name: 'test_memory',
        description: 'A test memory',
        type: 'user',
        createdAt: 1700000000000,
        updatedAt: 1700000000001,
      };

      const result = generateFrontmatter(header);

      expect(result).toContain('---');
      expect(result).toContain('name: test_memory');
      expect(result).toContain('description: A test memory');
      expect(result).toContain('type: user');
      expect(result).toContain('createdAt: 1700000000000');
      expect(result).toContain('updatedAt: 1700000000001');
    });

    it('should not include confidence if not set', () => {
      const header: MemoryHeader = {
        name: 'no_conf',
        description: 'desc',
        type: 'project',
      };

      const result = generateFrontmatter(header);
      expect(result).not.toContain('confidence');
    });

    it('should include confidence when set', () => {
      const header: MemoryHeader = {
        name: 'with_conf',
        description: 'desc',
        type: 'feedback',
        confidence: 'low',
      };

      const result = generateFrontmatter(header);
      expect(result).toContain('confidence: low');
    });

    it('should not include createdAt/updatedAt if not set', () => {
      const header: MemoryHeader = {
        name: 'no_timestamps',
        description: 'desc',
        type: 'reference',
      };

      const result = generateFrontmatter(header);
      expect(result).not.toContain('createdAt');
      expect(result).not.toContain('updatedAt');
    });

    it('should quote values containing special characters', () => {
      const header: MemoryHeader = {
        name: 'special: chars',
        description: 'Has # and & symbols',
        type: 'user',
      };

      const result = generateFrontmatter(header);
      expect(result).toContain('name: "special: chars"');
      expect(result).toContain('description: "Has # and & symbols"');
    });

    it('should quote values containing colons', () => {
      const header: MemoryHeader = {
        name: 'colon:value',
        description: 'normal',
        type: 'user',
      };

      const result = generateFrontmatter(header);
      expect(result).toContain('name: "colon:value"');
    });

    it('should quote values starting with special chars', () => {
      const header: MemoryHeader = {
        name: '"starts with quote',
        description: 'normal',
        type: 'user',
      };

      const result = generateFrontmatter(header);
      expect(result).toContain('name:');
    });

    it('should escape backslashes in quoted values', () => {
      const header: MemoryHeader = {
        name: 'path\\test',
        description: 'desc',
        type: 'user',
      };

      const result = generateFrontmatter(header);
      // Should contain escaped backslash
      expect(result).toContain('name:');
    });
  });

  describe('composeMemoryFile', () => {
    it('should compose a complete memory file', () => {
      const header: MemoryHeader = {
        name: 'composed',
        description: 'A composed file',
        type: 'project',
        createdAt: 1000,
        updatedAt: 2000,
      };

      const result = composeMemoryFile(header, 'Body content here.');

      expect(result).toContain('---');
      expect(result).toContain('name: composed');
      expect(result).toContain('Body content here.');
      expect(result.endsWith('\n')).toBe(true);
    });

    it('should handle empty content', () => {
      const header: MemoryHeader = {
        name: 'empty',
        description: 'desc',
        type: 'user',
      };

      const result = composeMemoryFile(header, '');
      expect(result).toContain('---');
      expect(result).toContain('name: empty');
    });
  });

  describe('parseMemoryFile', () => {
    it('should parse a complete memory file', () => {
      const content = `---
name: roundtrip
description: Test roundtrip
type: feedback
createdAt: 1000
---
Content body here.`;

      const result = parseMemoryFile(content);
      expect(result.header.name).toBe('roundtrip');
      expect(result.header.description).toBe('Test roundtrip');
      expect(result.header.type).toBe('feedback');
      expect(result.body).toBe('Content body here.');
    });

    it('should handle file without frontmatter', () => {
      const content = 'No frontmatter here.';
      const result = parseMemoryFile(content);
      expect(result.header).toEqual({});
      expect(result.body).toBe(content);
    });
  });

  describe('roundtrip: compose then parse', () => {
    it('should preserve header and body through compose/parse cycle', () => {
      const original: MemoryHeader = {
        name: 'roundtrip_test',
        description: 'Testing roundtrip fidelity',
        type: 'reference',
        createdAt: 1700000000000,
        updatedAt: 1700000000001,
        confidence: 'high',
      };
      const body = 'This is the body content with some details.';

      const composed = composeMemoryFile(original, body);
      const parsed = parseMemoryFile(composed);

      expect(parsed.header.name).toBe(original.name);
      expect(parsed.header.description).toBe(original.description);
      expect(parsed.header.type).toBe(original.type);
      expect(parsed.header.createdAt).toBe(original.createdAt);
      expect(parsed.header.updatedAt).toBe(original.updatedAt);
      expect(parsed.header.confidence).toBe(original.confidence);
      expect(parsed.body).toBe(body);
    });
  });
});
