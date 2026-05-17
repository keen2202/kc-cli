import { describe, it, expect, beforeEach } from 'vitest';
import { StateValidator } from '../../src/services/stateValidator';
import type { ChatMessage, AssistantMessage, ToolCall, ToolResult } from '../../src/types/message';
import { v4 as uuidv4 } from 'uuid';

function makeUserMessage(content: string): ChatMessage {
  return {
    id: uuidv4(),
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(content: string | null, toolCalls?: ToolCall[]): ChatMessage {
  return {
    id: uuidv4(),
    role: 'assistant',
    content,
    toolCalls,
    timestamp: Date.now(),
  };
}

function makeToolMessage(toolResults: ToolResult[]): ChatMessage {
  return {
    id: uuidv4(),
    role: 'tool',
    content: null,
    toolResults,
    timestamp: Date.now(),
  };
}

function makeToolCall(toolName: string): ToolCall {
  return {
    id: uuidv4(),
    toolName,
    input: {},
    status: 'completed',
  };
}

function makeToolResult(toolCallId: string, output = 'ok'): ToolResult {
  return {
    toolCallId,
    output,
    isError: false,
  };
}

describe('StateValidator', () => {
  let validator: StateValidator;

  beforeEach(() => {
    validator = new StateValidator();
  });

  describe('validate', () => {
    it('should pass clean conversation', () => {
      const tc = makeToolCall('Bash');
      const messages: ChatMessage[] = [
        makeUserMessage('run command'),
        makeAssistantMessage(null, [tc]),
        makeToolMessage([makeToolResult(tc.id, 'output')]),
        makeAssistantMessage('done'),
      ];

      const result = validator.validate(messages);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect orphaned tool result', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeToolMessage([makeToolResult('nonexistent-id', 'output')]),
      ];

      const result = validator.validate(messages);
      expect(result.valid).toBe(true); // orphaned is warning, not error
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('orphaned_tool_result');
      expect(result.issues[0].severity).toBe('warning');
    });

    it('should detect missing tool call result', () => {
      const tc = makeToolCall('Bash');
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage(null, [tc]),
        makeAssistantMessage('next message without tool result'),
      ];

      const result = validator.validate(messages);
      expect(result.issues.some(i => i.type === 'missing_tool_call')).toBe(true);
    });

    it('should detect invalid tool result with empty toolCallId', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeToolMessage([{ toolCallId: '', output: 'output', isError: false }]),
      ];

      const result = validator.validate(messages);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.type === 'invalid_tool_result')).toBe(true);
      expect(result.issues[0].severity).toBe('error');
    });

    it('should detect invalid tool call with empty id', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage(null, [{ id: '', toolName: 'Bash', input: {}, status: 'completed' }]),
      ];

      const result = validator.validate(messages);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.type === 'invalid_tool_result')).toBe(true);
    });

    it('should handle empty messages array', () => {
      const result = validator.validate([]);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should handle messages without tool calls', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('hello'),
        makeAssistantMessage('hi there'),
      ];

      const result = validator.validate(messages);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect multiple issues in a conversation', () => {
      const tc1 = makeToolCall('Bash');
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage(null, [tc1]),
        // No tool result for tc1
        makeAssistantMessage('next'),
        // Orphaned tool result
        makeToolMessage([makeToolResult('orphan-id', 'output')]),
      ];

      const result = validator.validate(messages);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('repair', () => {
    it('should remove orphaned tool results', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeToolMessage([makeToolResult('nonexistent-id', 'output')]),
      ];

      const result = validator.validate(messages);
      const repaired = validator.repair(messages, result.issues);

      // The tool message should still exist but with empty results
      // (or the orphaned result should be removed)
      expect(repaired.length).toBeLessThanOrEqual(messages.length);
    });

    it('should remove messages with all invalid results', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeToolMessage([{ toolCallId: '', output: 'output', isError: false }]),
      ];

      const result = validator.validate(messages);
      const repaired = validator.repair(messages, result.issues);

      // The invalid message should be removed
      expect(repaired.length).toBe(1);
      expect(repaired[0].role).toBe('user');
    });

    it('should keep valid results when some are invalid', () => {
      const validTc = makeToolCall('Bash');
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage(null, [validTc]),
        makeToolMessage([
          makeToolResult(validTc.id, 'valid output'),
          { toolCallId: '', output: 'invalid', isError: false },
        ]),
      ];

      const result = validator.validate(messages);
      const repaired = validator.repair(messages, result.issues);

      // Should keep the valid result
      const toolMsg = repaired.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect((toolMsg as any).toolResults.length).toBe(1);
      expect((toolMsg as any).toolResults[0].toolCallId).toBe(validTc.id);
    });

    it('should not modify messages when no issues', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage('response'),
      ];

      const result = validator.validate(messages);
      const repaired = validator.repair(messages, result.issues);

      expect(repaired).toEqual(messages);
    });
  });

  describe('needsValidation', () => {
    it('should return false for clean messages', () => {
      const tc = makeToolCall('Bash');
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage(null, [tc]),
        makeToolMessage([makeToolResult(tc.id, 'output')]),
      ];

      expect(validator.needsValidation(messages)).toBe(false);
    });

    it('should return true for tool message with empty toolCallId', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeToolMessage([{ toolCallId: '', output: 'output', isError: false }]),
      ];

      expect(validator.needsValidation(messages)).toBe(true);
    });

    it('should return true for tool message with no results', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        { id: uuidv4(), role: 'tool', content: null, toolResults: [], timestamp: Date.now() },
      ];

      expect(validator.needsValidation(messages)).toBe(true);
    });

    it('should return false for non-tool messages', () => {
      const messages: ChatMessage[] = [
        makeUserMessage('test'),
        makeAssistantMessage('response'),
      ];

      expect(validator.needsValidation(messages)).toBe(false);
    });
  });
});
