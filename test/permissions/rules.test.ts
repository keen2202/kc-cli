// Tests for permission rules - parsing, formatting, matching

import { describe, it, expect } from 'vitest';
import {
  parseRuleString,
  formatRuleString,
  matchRuleContent,
  createRulesFromConfig,
  mergeRuleSets,
  matchesAnyDenyRule,
  matchesAnyAllowRule,
} from '../../src/permissions/rules';

describe('PermissionRules', () => {
  describe('parseRuleString', () => {
    it('should parse simple tool name', () => {
      const result = parseRuleString('Bash');
      expect(result.toolName).toBe('Bash');
      expect(result.ruleContent).toBeUndefined();
    });

    it('should parse tool with content pattern', () => {
      const result = parseRuleString('Bash(ls *)');
      expect(result.toolName).toBe('Bash');
      expect(result.ruleContent).toBe('ls *');
    });

    it('should parse tool with file path', () => {
      const result = parseRuleString('FileWrite(/src/*)');
      expect(result.toolName).toBe('FileWrite');
      expect(result.ruleContent).toBe('/src/*');
    });

    it('should handle empty string', () => {
      const result = parseRuleString('');
      expect(result.toolName).toBe('');
    });

    it('should handle tool name with numbers', () => {
      const result = parseRuleString('Tool123');
      expect(result.toolName).toBe('Tool123');
    });
  });

  describe('formatRuleString', () => {
    it('should format simple rule', () => {
      expect(formatRuleString({ toolName: 'Bash', ruleContent: undefined })).toBe('Bash');
    });

    it('should format rule with content', () => {
      expect(formatRuleString({ toolName: 'Bash', ruleContent: 'ls *' })).toBe('Bash(ls *)');
    });

    it('should roundtrip parse/format', () => {
      const original = 'Bash(git commit:*)';
      expect(formatRuleString(parseRuleString(original))).toBe(original);
    });
  });

  describe('matchRuleContent', () => {
    it('should match exact content', () => {
      expect(matchRuleContent('ls -la', 'ls -la')).toBe(true);
      expect(matchRuleContent('ls -la', 'cat file.txt')).toBe(false);
    });

    it('should match wildcard * pattern', () => {
      expect(matchRuleContent('ls *', 'ls -la')).toBe(true);
      expect(matchRuleContent('ls *', 'ls -la /tmp')).toBe(true);
    });

    it('should match prefix pattern with :*', () => {
      expect(matchRuleContent('git:*', 'git status')).toBe(true);
      expect(matchRuleContent('git:*', 'git commit -m "msg"')).toBe(true);
      expect(matchRuleContent('git:*', 'npm run')).toBe(false);
    });

    it('should match ? wildcard', () => {
      expect(matchRuleContent('file?.txt', 'file1.txt')).toBe(true);
      expect(matchRuleContent('file?.txt', 'fileAB.txt')).toBe(false);
    });

    it('wildcard patterns should be case-insensitive', () => {
      expect(matchRuleContent('*.TS', 'file.ts')).toBe(true);
      expect(matchRuleContent('*.ts', 'FILE.TS')).toBe(true);
    });

    it('should handle empty pattern', () => {
      expect(matchRuleContent('', '')).toBe(true);
      expect(matchRuleContent('', 'anything')).toBe(false);
    });
  });

  describe('createRulesFromConfig', () => {
    it('should create rules with correct source and behavior', () => {
      const rules = createRulesFromConfig('cliArg', 'deny', ['Bash', 'FileWrite']);
      expect(rules).toHaveLength(2);
      expect(rules[0].source).toBe('cliArg');
      expect(rules[0].ruleBehavior).toBe('deny');
      expect(rules[0].ruleValue.toolName).toBe('Bash');
    });
  });

  describe('mergeRuleSets', () => {
    it('should merge rules from multiple sources', () => {
      const set1 = createRulesFromConfig('user', 'allow', ['FileRead']);
      const set2 = createRulesFromConfig('project', 'deny', ['Bash']);
      const merged = mergeRuleSets([set1, set2]);
      expect(merged).toHaveLength(2);
    });

    it('should deduplicate by rule key', () => {
      const set1 = createRulesFromConfig('user', 'allow', ['Bash']);
      const set2 = createRulesFromConfig('project', 'deny', ['Bash']);
      const merged = mergeRuleSets([set1, set2]);
      // Higher priority (project) should win
      expect(merged).toHaveLength(1);
    });
  });

  describe('matchesAnyDenyRule', () => {
    it('should match when tool name matches', () => {
      const rules = createRulesFromConfig('cliArg', 'deny', ['Bash']);
      expect(matchesAnyDenyRule(rules, 'Bash')).toBe(true);
      expect(matchesAnyDenyRule(rules, 'FileRead')).toBe(false);
    });

    it('should match with content pattern', () => {
      const rules = createRulesFromConfig('cliArg', 'deny', ['Bash(rm *)']);
      expect(matchesAnyDenyRule(rules, 'Bash', 'rm -rf /')).toBe(true);
      expect(matchesAnyDenyRule(rules, 'Bash', 'ls -la')).toBe(false);
    });
  });

  describe('matchesAnyAllowRule', () => {
    it('should match when tool name matches', () => {
      const rules = createRulesFromConfig('cliArg', 'allow', ['FileRead']);
      expect(matchesAnyAllowRule(rules, 'FileRead')).toBe(true);
      expect(matchesAnyAllowRule(rules, 'Bash')).toBe(false);
    });

    it('should match with content pattern', () => {
      const rules = createRulesFromConfig('cliArg', 'allow', ['Bash(ls *)']);
      expect(matchesAnyAllowRule(rules, 'Bash', 'ls -la')).toBe(true);
      expect(matchesAnyAllowRule(rules, 'Bash', 'rm -rf /')).toBe(false);
    });
  });
});
