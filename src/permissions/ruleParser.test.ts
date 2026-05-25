// Tests for enhanced permission rule parser

import { describe, it, expect } from 'vitest';
import {
  parseEnhancedRule,
  evaluateCondition,
  matchEnhancedPattern,
  evaluateRule,
  evaluateRules,
  validateRule,
  ruleToSimpleString,
} from './ruleParser';
import type { EnhancedPermissionRule, RuleEvaluationContext, ConditionExpression } from './ruleParser';

describe('parseEnhancedRule', () => {
  it('parses simple string rule', () => {
    const rule = parseEnhancedRule('Bash');
    expect(rule).toEqual({
      tool: 'Bash',
      behavior: 'ask',
    });
  });

  it('parses string rule with content pattern', () => {
    const rule = parseEnhancedRule('Bash(ls *)');
    expect(rule).toEqual({
      tool: 'Bash',
      command: 'ls *',
      behavior: 'ask',
    });
  });

  it('parses rule object', () => {
    const rule = parseEnhancedRule({
      name: 'Allow read commands',
      tool: 'Bash',
      command: 'ls *',
      behavior: 'allow',
      priority: 10,
      reason: 'Safe read command',
    });
    expect(rule).toEqual({
      name: 'Allow read commands',
      tool: 'Bash',
      command: 'ls *',
      behavior: 'allow',
      priority: 10,
      reason: 'Safe read command',
    });
  });

  it('returns null for invalid rule', () => {
    expect(parseEnhancedRule(null)).toBeNull();
    expect(parseEnhancedRule(123)).toBeNull();
    expect(parseEnhancedRule({ behavior: 'invalid' })).toBeNull();
  });

  it('parses rule with path pattern', () => {
    const rule = parseEnhancedRule({
      tool: 'FileWrite',
      path: '/src/**',
      behavior: 'allow',
    });
    expect(rule?.path).toBe('/src/**');
  });

  it('parses rule with env conditions', () => {
    const rule = parseEnhancedRule({
      tool: 'Bash',
      env: {
        NODE_ENV: 'production',
        DEBUG: { pattern: '*' },
      },
      behavior: 'deny',
    });
    expect(rule?.env).toEqual({
      NODE_ENV: 'production',
      DEBUG: { pattern: '*' },
    });
  });

  it('parses rule with when condition', () => {
    const rule = parseEnhancedRule({
      tool: 'Bash',
      when: {
        and: [
          { equals: { value: 'env.NODE_ENV', expected: 'production' } },
          { matches: { value: 'command', pattern: '^rm' } },
        ],
      },
      behavior: 'deny',
    });
    expect(rule?.when).toBeDefined();
  });
});

describe('evaluateCondition', () => {
  const context: RuleEvaluationContext = {
    toolName: 'Bash',
    command: 'rm -rf /tmp/test',
    path: '/tmp/test',
    env: {
      NODE_ENV: 'production',
      DEBUG: 'true',
    },
    cwd: '/workspace',
  };

  it('evaluates boolean condition', () => {
    expect(evaluateCondition(true, context)).toBe(true);
    expect(evaluateCondition(false, context)).toBe(false);
  });

  it('evaluates and condition', () => {
    const condition: ConditionExpression = {
      and: [
        { equals: { value: 'toolName', expected: 'Bash' } },
        { matches: { value: 'command', pattern: '^rm' } },
      ],
    };
    expect(evaluateCondition(condition, context)).toBe(true);
  });

  it('evaluates or condition', () => {
    const condition: ConditionExpression = {
      or: [
        { equals: { value: 'toolName', expected: 'FileRead' } },
        { matches: { value: 'command', pattern: '^rm' } },
      ],
    };
    expect(evaluateCondition(condition, context)).toBe(true);
  });

  it('evaluates not condition', () => {
    const condition: ConditionExpression = {
      not: { equals: { value: 'toolName', expected: 'FileRead' } },
    };
    expect(evaluateCondition(condition, context)).toBe(true);
  });

  it('evaluates equals condition', () => {
    expect(evaluateCondition(
      { equals: { value: 'env.NODE_ENV', expected: 'production' } },
      context
    )).toBe(true);

    expect(evaluateCondition(
      { equals: { value: 'env.NODE_ENV', expected: 'development' } },
      context
    )).toBe(false);
  });

  it('evaluates matches condition', () => {
    expect(evaluateCondition(
      { matches: { value: 'command', pattern: '^rm' } },
      context
    )).toBe(true);

    expect(evaluateCondition(
      { matches: { value: 'command', pattern: '^ls' } },
      context
    )).toBe(false);
  });

  it('evaluates contains condition', () => {
    expect(evaluateCondition(
      { contains: { value: 'command', substring: 'rf' } },
      context
    )).toBe(true);
  });

  it('evaluates startsWith condition', () => {
    expect(evaluateCondition(
      { startsWith: { value: 'command', prefix: 'rm' } },
      context
    )).toBe(true);
  });

  it('evaluates endsWith condition', () => {
    expect(evaluateCondition(
      { endsWith: { value: 'path', suffix: 'test' } },
      context
    )).toBe(true);
  });

  it('evaluates nested conditions', () => {
    const condition: ConditionExpression = {
      and: [
        { equals: { value: 'toolName', expected: 'Bash' } },
        {
          or: [
            { matches: { value: 'command', pattern: '^rm' } },
            { matches: { value: 'command', pattern: '^dd' } },
          ],
        },
      ],
    };
    expect(evaluateCondition(condition, context)).toBe(true);
  });
});

describe('matchEnhancedPattern', () => {
  it('matches exact string', () => {
    expect(matchEnhancedPattern('Bash', 'Bash')).toBe(true);
    expect(matchEnhancedPattern('Bash', 'FileRead')).toBe(false);
  });

  it('matches glob pattern', () => {
    expect(matchEnhancedPattern('Bash', 'Bash')).toBe(true);
    expect(matchEnhancedPattern('B*', 'Bash')).toBe(true);
    expect(matchEnhancedPattern('*Tool', 'BashTool')).toBe(true);
    expect(matchEnhancedPattern('B?sh', 'Bash')).toBe(true);
    expect(matchEnhancedPattern('B?sh', 'Bush')).toBe(true); // ? matches any single char
    expect(matchEnhancedPattern('B?sh', 'BashTool')).toBe(false);
  });

  it('matches regex pattern', () => {
    expect(matchEnhancedPattern('/^Bash$/', 'Bash')).toBe(true);
    expect(matchEnhancedPattern('/^Bash$/', 'BashTool')).toBe(false);
    expect(matchEnhancedPattern('/^B/', 'Bash')).toBe(true);
  });
});

describe('evaluateRule', () => {
  const context: RuleEvaluationContext = {
    toolName: 'Bash',
    command: 'ls -la /tmp',
    path: '/tmp',
    env: { NODE_ENV: 'production' },
    cwd: '/workspace',
  };

  it('matches tool name', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      behavior: 'allow',
    };
    expect(evaluateRule(rule, context).matched).toBe(true);
  });

  it('does not match wrong tool name', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'FileRead',
      behavior: 'allow',
    };
    expect(evaluateRule(rule, context).matched).toBe(false);
  });

  it('matches command pattern', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      command: 'ls *',
      behavior: 'allow',
    };
    expect(evaluateRule(rule, context).matched).toBe(true);
  });

  it('matches path pattern', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      path: '/tmp',
      behavior: 'allow',
    };
    expect(evaluateRule(rule, context).matched).toBe(true);
  });

  it('matches env condition', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      env: { NODE_ENV: 'production' },
      behavior: 'deny',
    };
    expect(evaluateRule(rule, context).matched).toBe(true);
  });

  it('matches when condition', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      when: { matches: { value: 'command', pattern: '^ls' } },
      behavior: 'allow',
    };
    expect(evaluateRule(rule, context).matched).toBe(true);
  });

  it('skips disabled rules', () => {
    const rule: EnhancedPermissionRule = {
      tool: 'Bash',
      behavior: 'allow',
      enabled: false,
    };
    expect(evaluateRule(rule, context).matched).toBe(false);
  });
});

describe('evaluateRules', () => {
  const context: RuleEvaluationContext = {
    toolName: 'Bash',
    command: 'ls -la /tmp',
    path: '/tmp',
    cwd: '/workspace',
  };

  it('returns first matching rule by priority', () => {
    const rules: EnhancedPermissionRule[] = [
      { tool: 'Bash', behavior: 'ask', priority: 1 },
      { tool: 'Bash', command: 'ls *', behavior: 'allow', priority: 10 },
      { tool: 'Bash', behavior: 'deny', priority: 5 },
    ];
    const result = evaluateRules(rules, context);
    expect(result.matched).toBe(true);
    expect(result.rule?.behavior).toBe('allow');
  });

  it('returns no match if no rules match', () => {
    const rules: EnhancedPermissionRule[] = [
      { tool: 'FileRead', behavior: 'allow' },
    ];
    expect(evaluateRules(rules, context).matched).toBe(false);
  });
});

describe('validateRule', () => {
  it('validates simple string rule', () => {
    expect(validateRule('Bash').valid).toBe(true);
  });

  it('validates rule object', () => {
    expect(validateRule({
      tool: 'Bash',
      behavior: 'allow',
    }).valid).toBe(true);
  });

  it('rejects invalid behavior', () => {
    const result = validateRule({ behavior: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Rule must have a behavior of "allow", "deny", or "ask"');
  });

  it('rejects non-object rule', () => {
    expect(validateRule(123).valid).toBe(false);
    expect(validateRule(null).valid).toBe(false);
  });
});

describe('ruleToSimpleString', () => {
  it('converts simple tool rule', () => {
    expect(ruleToSimpleString({ tool: 'Bash', behavior: 'allow' })).toBe('Bash');
  });

  it('converts tool with command', () => {
    expect(ruleToSimpleString({ tool: 'Bash', command: 'ls *', behavior: 'allow' })).toBe('Bash(ls *)');
  });

  it('converts complex rule to generic format', () => {
    expect(ruleToSimpleString({
      tool: 'Bash',
      path: '/tmp/**',
      behavior: 'deny',
    })).toBe('Bash(deny)');
  });
});
