import { describe, it, expect } from 'vitest';
import {
  detectTaskType,
  isConversationalMessage,
  estimateTaskComplexity,
} from '../../src/api/prompts/task-prompts';

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

  it('should detect Chinese task types (H1)', () => {
    expect(detectTaskType('修复登录错误')).toBe('debugging');
    expect(detectTaskType('调试崩溃问题')).toBe('debugging');
    expect(detectTaskType('重构认证模块')).toBe('refactoring');
    expect(detectTaskType('优化数据库查询')).toBe('refactoring');
    expect(detectTaskType('编写接口文档')).toBe('documentation');
    expect(detectTaskType('创建一个新组件')).toBe('code-gen');
    expect(detectTaskType('实现用户登录')).toBe('code-gen');
  });
});

describe('isConversationalMessage', () => {
  it('treats greetings as conversational (EN + CN)', () => {
    expect(isConversationalMessage('hi')).toBe(true);
    expect(isConversationalMessage('hello there')).toBe(true);
    expect(isConversationalMessage('你好')).toBe(true);
    expect(isConversationalMessage('您好！')).toBe(true);
  });

  it('treats capability questions as conversational', () => {
    expect(isConversationalMessage('what can you do')).toBe(true);
    expect(isConversationalMessage('who are you')).toBe(true);
  });

  it('treats empty input as conversational', () => {
    expect(isConversationalMessage('')).toBe(true);
    expect(isConversationalMessage('   ')).toBe(true);
  });

  it('does NOT treat English task requests as conversational', () => {
    expect(isConversationalMessage('fix the bug')).toBe(false);
    expect(isConversationalMessage('find the config file')).toBe(false);
  });

  it('does NOT treat short Chinese task requests as conversational (H1)', () => {
    expect(isConversationalMessage('帮我查找 config 文件')).toBe(false);
    expect(isConversationalMessage('修复这个错误')).toBe(false);
    expect(isConversationalMessage('重构这段代码')).toBe(false);
  });

  it('treats short Chinese small-talk as conversational', () => {
    expect(isConversationalMessage('今天天气不错')).toBe(true);
  });
});

describe('estimateTaskComplexity', () => {
  it('returns simple/low budget for conversational input', () => {
    const est = estimateTaskComplexity('你好');
    expect(est.complexity).toBe('simple');
    expect(est.suggestedTurns).toBe(5);
  });

  it('scores Chinese cross-project signals as complex (H1)', () => {
    const est = estimateTaskComplexity('重构整个项目的认证模块并更新所有相关文件');
    expect(est.complexity).toBe('complex');
  });

  it('scores English cross-project signals as complex (regression)', () => {
    const est = estimateTaskComplexity('refactor the entire codebase and update all files');
    expect(est.complexity).toBe('complex');
  });
});
