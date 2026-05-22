import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserProfileService, detectCodingStyle } from '../../src/services/userProfile';

vi.mock('fs/promises', async () => {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  };
});

import * as fs from 'fs/promises';

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);

describe('UserProfileService - coverage', () => {
  let service: UserProfileService;

  beforeEach(() => {
    service = new UserProfileService('/test/settings.json');
    vi.clearAllMocks();
  });

  describe('getProfile', () => {
    it('should return a copy of the profile', () => {
      const p1 = service.getProfile();
      const p2 = service.getProfile();
      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2); // Should be a copy
    });
  });

  describe('updateLevel', () => {
    it('should update the user level', () => {
      service.updateLevel('advanced');
      expect(service.getLevel()).toBe('advanced');
    });

    it('should update the timestamp', () => {
      const before = service.getProfile().updatedAt;
      service.updateLevel('intermediate');
      expect(service.getProfile().updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('recordToolPreference', () => {
    it('should add tool to preferred tools', () => {
      service.recordToolPreference('Bash');
      expect(service.getPreferredTools()).toContain('Bash');
    });

    it('should not duplicate tools', () => {
      service.recordToolPreference('Bash');
      service.recordToolPreference('Bash');
      expect(service.getPreferredTools().filter(t => t === 'Bash')).toHaveLength(1);
    });

    it('should keep only last 10 tools', () => {
      for (let i = 0; i < 15; i++) {
        service.recordToolPreference(`Tool${i}`);
      }
      expect(service.getPreferredTools()).toHaveLength(10);
      expect(service.getPreferredTools()).toContain('Tool14');
      expect(service.getPreferredTools()).not.toContain('Tool0');
    });

    it('should increment total tool calls', () => {
      service.recordToolPreference('Bash');
      service.recordToolPreference('FileRead');
      expect(service.getProfile().totalToolCalls).toBe(2);
    });
  });

  describe('recordCodingStyle', () => {
    it('should update primary language', () => {
      service.recordCodingStyle({ primaryLanguage: 'TypeScript' });
      expect(service.getCodingStyle().primaryLanguage).toBe('TypeScript');
    });

    it('should update indentation', () => {
      service.recordCodingStyle({ indentation: 'spaces', indentSize: 2 });
      expect(service.getCodingStyle().indentation).toBe('spaces');
      expect(service.getCodingStyle().indentSize).toBe(2);
    });

    it('should update naming convention', () => {
      service.recordCodingStyle({ namingConvention: 'camelCase' });
      expect(service.getCodingStyle().namingConvention).toBe('camelCase');
    });

    it('should not overwrite fields with undefined', () => {
      service.recordCodingStyle({ primaryLanguage: 'Python' });
      service.recordCodingStyle({ indentation: 'spaces' });
      expect(service.getCodingStyle().primaryLanguage).toBe('Python');
    });
  });

  describe('incrementSessionCount', () => {
    it('should increment session count', () => {
      service.incrementSessionCount();
      service.incrementSessionCount();
      expect(service.getProfile().sessionCount).toBe(2);
    });
  });

  describe('persist', () => {
    it('should write profile to disk', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      mockWriteFile.mockResolvedValue(undefined);

      await service.persist();

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/settings.json',
        expect.stringContaining('userProfile'),
        'utf-8'
      );
    });

    it('should merge with existing settings', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(JSON.stringify({ otherKey: 'value' }));
      mockWriteFile.mockResolvedValue(undefined);

      await service.persist();

      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written.otherKey).toBe('value');
      expect(written.userProfile).toBeDefined();
    });

    it('should handle invalid JSON in existing settings', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('not json');
      mockWriteFile.mockResolvedValue(undefined);

      await service.persist();
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('should load profile from disk', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        userProfile: {
          level: 'advanced',
          preferredTools: ['Bash'],
          sessionCount: 5,
          codingStyle: { primaryLanguage: 'Go' },
        },
      }));

      await service.load();
      expect(service.getLevel()).toBe('advanced');
      expect(service.getPreferredTools()).toContain('Bash');
      expect(service.getProfile().sessionCount).toBe(5);
    });

    it('should handle missing file gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await expect(service.load()).resolves.not.toThrow();
    });

    it('should handle invalid JSON gracefully', async () => {
      mockReadFile.mockResolvedValue('invalid');
      await expect(service.load()).resolves.not.toThrow();
    });

    it('should handle missing userProfile key', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ otherKey: 'value' }));
      await service.load();
      expect(service.getLevel()).toBe('beginner'); // Default
    });

    it('should merge coding style with defaults', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        userProfile: {
          codingStyle: { primaryLanguage: 'Rust' },
        },
      }));

      await service.load();
      expect(service.getCodingStyle().primaryLanguage).toBe('Rust');
    });
  });

  describe('reset', () => {
    it('should reset profile to defaults', () => {
      service.updateLevel('advanced');
      service.recordToolPreference('Bash');
      service.incrementSessionCount();

      service.reset();

      expect(service.getLevel()).toBe('beginner');
      expect(service.getPreferredTools()).toHaveLength(0);
      expect(service.getProfile().sessionCount).toBe(0);
    });
  });
});

describe('detectCodingStyle - coverage', () => {
  it('should detect TypeScript from .ts extension', () => {
    const style = detectCodingStyle('const x = 1;', 'file.ts');
    expect(style.primaryLanguage).toBe('TypeScript');
  });

  it('should detect JavaScript from .js extension', () => {
    const style = detectCodingStyle('var x = 1;', 'file.js');
    expect(style.primaryLanguage).toBe('JavaScript');
  });

  it('should detect Python from .py extension', () => {
    const style = detectCodingStyle('x = 1', 'file.py');
    expect(style.primaryLanguage).toBe('Python');
  });

  it('should detect Rust from .rs extension', () => {
    const style = detectCodingStyle('fn main() {}', 'file.rs');
    expect(style.primaryLanguage).toBe('Rust');
  });

  it('should detect Go from .go extension', () => {
    const style = detectCodingStyle('package main', 'file.go');
    expect(style.primaryLanguage).toBe('Go');
  });

  it('should detect Java from .java extension', () => {
    const style = detectCodingStyle('class Foo {}', 'file.java');
    expect(style.primaryLanguage).toBe('Java');
  });

  it('should detect Ruby from .rb extension', () => {
    const style = detectCodingStyle('puts "hi"', 'file.rb');
    expect(style.primaryLanguage).toBe('Ruby');
  });

  it('should detect C++ from .cpp extension', () => {
    const style = detectCodingStyle('#include <iostream>', 'file.cpp');
    expect(style.primaryLanguage).toBe('C++');
  });

  it('should detect C from .c extension', () => {
    const style = detectCodingStyle('#include <stdio.h>', 'file.c');
    expect(style.primaryLanguage).toBe('C');
  });

  it('should detect JSX as JavaScript', () => {
    const style = detectCodingStyle('<div />', 'file.jsx');
    expect(style.primaryLanguage).toBe('JavaScript');
  });

  it('should detect TSX as TypeScript', () => {
    const style = detectCodingStyle('<div />', 'file.tsx');
    expect(style.primaryLanguage).toBe('TypeScript');
  });

  it('should detect spaces indentation', () => {
    const content = '  const x = 1;\n    const y = 2;\n  const z = 3;';
    const style = detectCodingStyle(content, 'file.ts');
    expect(style.indentation).toBe('spaces');
    expect(style.indentSize).toBe(2);
  });

  it('should detect tabs indentation', () => {
    const content = '\tconst x = 1;\n\t\tconst y = 2;\n\tconst z = 3;';
    const style = detectCodingStyle(content, 'file.ts');
    expect(style.indentation).toBe('tabs');
  });

  it('should detect snake_case naming', () => {
    const style = detectCodingStyle('', 'my_file.ts');
    expect(style.namingConvention).toBe('snake_case');
  });

  it('should detect PascalCase naming', () => {
    const style = detectCodingStyle('', 'MyFile.ts');
    expect(style.namingConvention).toBe('PascalCase');
  });

  it('should detect camelCase naming', () => {
    const style = detectCodingStyle('', 'myFile.ts');
    expect(style.namingConvention).toBe('camelCase');
  });

  it('should not set language for unknown extensions', () => {
    const style = detectCodingStyle('data', 'file.xyz');
    expect(style.primaryLanguage).toBeUndefined();
  });

  it('should handle empty content', () => {
    const style = detectCodingStyle('', 'file.ts');
    expect(style.primaryLanguage).toBe('TypeScript');
  });
});
