// Compile-time type validation fixture (NOT a runtime test).
// Exercises public API signatures so `npx tsc --noEmit` catches breaking
// type changes; vitest does not execute this file.

import { createAPIClient, LLMProvider } from '../src/api';
import type { ToolResult } from '../src/types/message';
import type { ToolResult as ToolResultGeneric } from '../src/types/tools';

// Test 1: API Client creation
function testAPIClient() {
  // OpenAI
  const openaiClient = createAPIClient({
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4',
  });
  console.log('✓ OpenAI client created');

  // Qwen
  const qwenClient = createAPIClient({
    provider: 'qwen',
    apiKey: 'sk-test',
    model: 'qwen-plus',
  });
  console.log('✓ Qwen client created');

  // GLM
  const glmClient = createAPIClient({
    provider: 'glm',
    apiKey: 'test-key',
    model: 'glm-4',
  });
  console.log('✓ GLM client created');

  // Anthropic
  const anthropicClient = createAPIClient({
    provider: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'claude-3-5-sonnet-20241022',
  });
  console.log('✓ Anthropic client created');

  // Ollama
  const ollamaClient = createAPIClient({
    provider: 'ollama',
    model: 'llama3',
  });
  console.log('✓ Ollama client created');
}

// Test 2: ToolResult types
function testToolResult() {
  // ToolResult from message.ts (should be ToolResult<string>)
  const msgResult: ToolResult = {
    toolCallId: 'call_1',
    output: 'test output',
    isError: false,
  };
  console.log('✓ ToolResult (message) type is valid');

  // ToolResult from tools.ts (generic)
  const genericResult: ToolResultGeneric<number> = {
    output: 42,
    isError: false,
  };
  console.log('✓ ToolResult<T> (tools) type is valid');
}

// Run tests
try {
  testAPIClient();
  testToolResult();
  console.log('\n✅ All type checks passed!');
} catch (error) {
  console.error('\n❌ Type check failed:', error);
  process.exit(1);
}
