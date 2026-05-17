import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserProfileService, detectCodingStyle } from '../../src/services/userProfile';

// Mock fs for persistence tests
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

describe('UserProfileService', () => {
  let service: UserProfileService;

  beforeEach(() => {
    service = new UserProfileService('/tmp/test-settings.json');
    vi.clearAllMocks();
  });

  describe('getProfile', () => {
    it('should return default profile', () => {
      const profile = service.getProfile();
      expect(profile.level).toBe('beginner');
      expect(profile.preferredTools).toEqual([]);
      expect(profile.sessionCount).toBe(0);
      expect(profile.totalToolCalls).toBe(0);
    });
  });

  describe('updateLevel', () => {
    it('should update user level', () => {
      service.updateLevel('intermediate');
      expect(service.getLevel()).toBe('intermediate');
    });

    it('should accept all valid levels', () => {
      service.updateLevel('beginner');
      expect(service.getLevel()).toBe('beginner');

      service.updateLevel('intermediate');
      expect(service.getLevel()).toBe('intermediate');

      service.updateLevel('advanced');
      expect(service.getLevel()).toBe('advanced');
    });
  });

  describe('recordToolPreference', () => {
    it('should record tool usage', () => {
      service.recordToolPreference('Read');
      service.recordToolPreference('Write');
      service.recordToolPreference('Bash');

      const tools = service.getPreferredTools();
      expect(tools).toContain('Read');
      expect(tools).toContain('Write');
      expect(tools).toContain('Bash');
    });

    it('should not duplicate tools', () => {
      service.recordToolPreference('Read');
      service.recordToolPreference('Read');
      service.recordToolPreference('Read');

      const tools = service.getPreferredTools();
      expect(tools.filter(t => t === 'Read').length).toBe(1);
    });

    it('should keep top 10 tools', () => {
      for (let i = 0; i < 15; i++) {
        service.recordToolPreference(`Tool${i}`);
      }

      const tools = service.getPreferredTools();
      expect(tools.length).toBeLessThanOrEqual(10);
    });

    it('should increment total tool calls', () => {
      service.recordToolPreference('Read');
      service.recordToolPreference('Write');

      const profile = service.getProfile();
      expect(profile.totalToolCalls).toBe(2);
    });
  });

  describe('recordCodingStyle', () => {
    it('should record coding style', () => {
      service.recordCodingStyle({
        primaryLanguage: 'TypeScript',
        indentation: 'spaces',
        indentSize: 2,
        namingConvention: 'camelCase',
      });

      const style = service.getCodingStyle();
      expect(style.primaryLanguage).toBe('TypeScript');
      expect(style.indentation).toBe('spaces');
      expect(style.indentSize).toBe(2);
      expect(style.namingConvention).toBe('camelCase');
    });

    it('should partially update coding style', () => {
      service.recordCodingStyle({ primaryLanguage: 'Python' });
      service.recordCodingStyle({ indentation: 'spaces' });

      const style = service.getCodingStyle();
      expect(style.primaryLanguage).toBe('Python');
      expect(style.indentation).toBe('spaces');
    });
  });

  describe('incrementSessionCount', () => {
    it('should increment session count', () => {
      service.incrementSessionCount();
      service.incrementSessionCount();

      const profile = service.getProfile();
      expect(profile.sessionCount).toBe(2);
    });
  });

  describe('reset', () => {
    it('should reset profile to defaults', () => {
      service.updateLevel('advanced');
      service.recordToolPreference('Read');
      service.incrementSessionCount();

      service.reset();

      const profile = service.getProfile();
      expect(profile.level).toBe('beginner');
      expect(profile.preferredTools).toEqual([]);
      expect(profile.sessionCount).toBe(0);
    });
  });
});

describe('detectCodingStyle', () => {
  it('should detect TypeScript from .ts extension', () => {
    const style = detectCodingStyle('const x = 1;', 'test.ts');
    expect(style.primaryLanguage).toBe('TypeScript');
  });

  it('should detect Python from .py extension', () => {
    const style = detectCodingStyle('x = 1', 'test.py');
    expect(style.primaryLanguage).toBe('Python');
  });

  it('should detect space indentation', () => {
    const content = 'function test() {\n  const x = 1;\n  return x;\n}';
    const style = detectCodingStyle(content, 'test.ts');
    expect(style.indentation).toBe('spaces');
    expect(style.indentSize).toBe(2);
  });

  it('should detect tab indentation', () => {
    const content = 'function test() {\n\tconst x = 1;\n\treturn x;\n}';
    const style = detectCodingStyle(content, 'test.ts');
    expect(style.indentation).toBe('tabs');
  });

  it('should detect snake_case naming', () => {
    const style = detectCodingStyle('', 'my_file_name.ts');
    expect(style.namingConvention).toBe('snake_case');
  });

  it('should detect PascalCase naming', () => {
    const style = detectCodingStyle('', 'MyComponent.tsx');
    expect(style.namingConvention).toBe('PascalCase');
  });

  it('should detect camelCase naming', () => {
    const style = detectCodingStyle('', 'myHelper.ts');
    expect(style.namingConvention).toBe('camelCase');
  });
});
