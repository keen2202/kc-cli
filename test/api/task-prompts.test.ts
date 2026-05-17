import { describe, it, expect } from 'vitest';
import { detectTaskType } from '../../src/api/prompts/task-prompts';

describe('Task Type Detection', () => {
  it('should detect debugging tasks', () => {
    expect(detectTaskType('fix the bug in login')).toBe('debugging');
    expect(detectTaskType('this is not working')).toBe('debugging');
    expect(detectTaskType('debug the crash')).toBe('debugging');
    expect(detectTaskType('test fails with error')).toBe('debugging');
  });

  it('should detect refactoring tasks', () => {
    expect(detectTaskType('refactor the auth module')).toBe('refactoring');
    expect(detectTaskType('clean up the code')).toBe('refactoring');
    expect(detectTaskType('improve performance')).toBe('refactoring');
    expect(detectTaskType('optimize database queries')).toBe('refactoring');
    expect(detectTaskType('restructure the project')).toBe('refactoring');
  });

  it('should detect documentation tasks', () => {
    expect(detectTaskType('document the API')).toBe('documentation');
    expect(detectTaskType('update README')).toBe('documentation');
    expect(detectTaskType('explain this code')).toBe('documentation');
    expect(detectTaskType('add comments')).toBe('documentation');
    expect(detectTaskType('write jsdoc for functions')).toBe('documentation');
  });

  it('should detect code generation tasks', () => {
    expect(detectTaskType('create a new component')).toBe('code-gen');
    expect(detectTaskType('implement user login')).toBe('code-gen');
    expect(detectTaskType('add validation')).toBe('code-gen');
    expect(detectTaskType('write a test case')).toBe('code-gen');
    expect(detectTaskType('build the API endpoint')).toBe('code-gen');
    expect(detectTaskType('new feature for dashboard')).toBe('code-gen');
  });

  it('should return general for non-specific tasks', () => {
    expect(detectTaskType('hello world')).toBe('general');
    expect(detectTaskType('what is the weather')).toBe('general');
  });

  it('should be case insensitive', () => {
    expect(detectTaskType('FIX the BUG')).toBe('debugging');
    expect(detectTaskType('REFACTOR this')).toBe('refactoring');
    expect(detectTaskType('CREATE a file')).toBe('code-gen');
  });

  it('should handle empty input', () => {
    expect(detectTaskType('')).toBe('general');
  });
});
