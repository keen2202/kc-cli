import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectTaskType,
  isConversationalMessage,
  estimateTaskComplexity,
} from '../../src/api/prompts/task-prompts';
import {
  isSystemWriteDirectory,
  isProtectedPath,
  containsProtectedPath,
} from '../../src/permissions/protectedPaths';
import {
  findRelevantMemories,
  resetRelevanceState,
} from '../../src/memory/relevanceSearch';
import type { MemoryManifestEntry } from '../../src/memory/types';
import { tool as askUserTool } from '../../src/tools/AskUserTool';
import type { ToolUseContext } from '../../src/tools/protocol';

/**
 * End-to-end coverage for the intent / context / boundary hardening (H1–H4).
 * Each scenario exercises a full cross-language user journey rather than a
 * single unit, matching the spec's four hardening areas.
 */

function makeContext(partial: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    cwd: process.cwd(),
    abortController: new AbortController(),
    permissions: {} as ToolUseContext['permissions'],
    env: {} as ToolUseContext['env'],
    ...partial,
  };
}

describe('intent-context-hardening (integration)', () => {
  // ── Scenario 1: 中文"查找" 意图被正确分类（H1） ──
  describe('Scenario 1 — Chinese "find" intent classification (H1)', () => {
    it('treats a short Chinese find request as task-oriented, not chit-chat', () => {
      const msg = '帮我查找 config 文件';
      expect(isConversationalMessage(msg)).toBe(false);
      // Not conversational → complexity estimation does not collapse to the
      // minimal conversational budget.
      expect(estimateTaskComplexity(msg).suggestedTurns).toBeGreaterThan(5);
    });

    it('still recognizes a Chinese greeting as conversational', () => {
      expect(isConversationalMessage('你好')).toBe(true);
      expect(isConversationalMessage('早上好！')).toBe(true);
    });
  });

  // ── Scenario 2: 中文"修改/调试" 任务类型识别（H1） ──
  describe('Scenario 2 — Chinese modify/debug task typing (H1)', () => {
    it('maps Chinese debugging keywords to the debugging task type', () => {
      expect(detectTaskType('修复登录时的崩溃错误')).toBe('debugging');
      expect(detectTaskType('排查这个异常')).toBe('debugging');
    });

    it('maps Chinese refactor/doc/codegen keywords to their task types', () => {
      expect(detectTaskType('重构用户服务模块')).toBe('refactoring');
      expect(detectTaskType('给这个函数补充文档说明')).toBe('documentation');
      expect(detectTaskType('实现一个新的缓存层')).toBe('code-gen');
    });

    it('escalates a Chinese cross-project + test-and-implement request to complex', () => {
      const est = estimateTaskComplexity('在整个项目里为所有模块实现单元测试并补充实现');
      expect(est.complexity).toBe('complex');
    });
  });

  // ── Scenario 3: 越界写系统目录/凭据被拦（H3, Windows + Unix） ──
  describe('Scenario 3 — out-of-bounds writes are blocked cross-platform (H3)', () => {
    it('flags Windows system directories as system-write locations', () => {
      expect(isSystemWriteDirectory('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true);
      expect(isSystemWriteDirectory('C:\\Program Files\\app\\x.dll')).toBe(true);
      expect(isSystemWriteDirectory('c:/programdata/secret.cfg')).toBe(true);
    });

    it('keeps flagging Unix system directories (no regression)', () => {
      expect(isSystemWriteDirectory('/etc/hosts')).toBe(true);
      expect(isSystemWriteDirectory('/usr/local/bin/x')).toBe(true);
    });

    it('does not flag ordinary workspace paths', () => {
      expect(isSystemWriteDirectory('C:\\Users\\me\\project\\src\\index.ts')).toBe(false);
      expect(isSystemWriteDirectory('/home/me/project/src/index.ts')).toBe(false);
    });

    it('detects Windows credential paths as protected', () => {
      expect(isProtectedPath('C:\\Users\\me\\.ssh\\id_rsa')).toBe(true);
      expect(isProtectedPath('C:\\Users\\me\\.aws\\credentials')).toBe(true);
      expect(containsProtectedPath('type C:\\Users\\me\\.ssh\\id_rsa')).toBe(true);
    });

    it('detects protected paths inside a command string with %USERPROFILE%', () => {
      expect(containsProtectedPath('copy %USERPROFILE%\\.ssh\\id_rsa .')).toBe(true);
    });
  });

  // ── Scenario 4: CJK query 命中中文记忆（H2） ──
  describe('Scenario 4 — CJK query retrieves Chinese memories (H2)', () => {
    beforeEach(() => {
      resetRelevanceState();
    });

    it('returns the Chinese-described memory ahead of unrelated ones', () => {
      const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const memories: MemoryManifestEntry[] = [
        {
          fileName: 'auth-decision.md',
          description: '用户认证采用 JWT 令牌方案，避免会话存储',
          type: 'project',
          mtime: old,
          confidence: 'high',
        },
        {
          fileName: 'unrelated-note.md',
          description: 'random cooking recipe about pasta and tomatoes',
          type: 'reference',
          mtime: old,
        },
      ];

      const result = findRelevantMemories('认证方案是怎么决定的', memories, undefined, 2);
      expect(result[0]).toBe('auth-decision.md');
    });

    it('returns nothing relevant-first for a fully unrelated CJK query', () => {
      const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const memories: MemoryManifestEntry[] = [
        {
          fileName: 'auth-decision.md',
          description: '用户认证采用 JWT 令牌方案',
          type: 'project',
          mtime: old,
        },
      ];
      // Query shares no tokens with the memory → score stays 0, so while it may
      // still be returned (only candidate), its score must not be inflated.
      const result = findRelevantMemories('今天天气很好', memories, undefined, 5);
      expect(result).toEqual(['auth-decision.md']);
    });
  });

  // ── Scenario 5: 交互澄清不降级（H4） ──
  describe('Scenario 5 — interaction clarification does not silently degrade (H4)', () => {
    it('routes through a registered interaction handler when present', async () => {
      const ctx = makeContext({
        interaction: { ask: async () => '用 JWT' },
      });
      const result = await askUserTool.call(
        { question: '会话还是 JWT?', options: ['会话', 'JWT'] },
        ctx
      );
      expect(result.isError).toBe(false);
      expect(result.output).toBe('用 JWT');
      expect(result.metadata?.source).toBe('handler');
    });

    it('falls back to default_answer in a non-interactive environment', async () => {
      const original = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      try {
        const result = await askUserTool.call(
          { question: '继续吗?', default_answer: '是' },
          makeContext()
        );
        expect(result.isError).toBe(false);
        expect(result.output).toBe('是');
        expect(result.metadata?.source).toBe('default');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
      }
    });

    it('fails explicitly (no misleading placeholder) when no input is possible', async () => {
      const original = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      try {
        const result = await askUserTool.call({ question: '继续吗?' }, makeContext());
        expect(result.isError).toBe(true);
        expect(result.message).toBe('interactive input unavailable');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
      }
    });
  });
});
