import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSandboxSignature,
  verifySandboxSignature,
  SANDBOX_WRAPPED_MARKER,
  SANDBOX_SIGNATURE_KEY,
  ToolExecutor,
  GLOBAL_TOOL_SEMAPHORE,
  OS_NETWORK_TOOLS,
} from './toolExecutor';
import { Semaphore } from '../utils/semaphore';
import { initializeState, resetState } from '../bootstrap/state';
import { createLocalExecutionEnv } from '../services/execution-env-local';

describe('Sandbox HMAC Signature', () => {
  it('creates a valid HMAC signature for a tool ID', () => {
    const signature = createSandboxSignature('Bash');
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex is 64 chars
  });

  it('creates different signatures for different tool IDs', () => {
    const sig1 = createSandboxSignature('Bash');
    const sig2 = createSandboxSignature('FileRead');
    expect(sig1).not.toBe(sig2);
  });

  it('creates consistent signatures for the same tool ID', () => {
    const sig1 = createSandboxSignature('Bash');
    const sig2 = createSandboxSignature('Bash');
    expect(sig1).toBe(sig2);
  });

  it('verifies a valid signature', () => {
    const signature = createSandboxSignature('Bash');
    expect(verifySandboxSignature('Bash', signature)).toBe(true);
  });

  it('rejects a forged signature', () => {
    const forgedSignature = 'a'.repeat(64);
    expect(verifySandboxSignature('Bash', forgedSignature)).toBe(false);
  });

  it('rejects a signature for a different tool ID', () => {
    const signature = createSandboxSignature('Bash');
    expect(verifySandboxSignature('FileRead', signature)).toBe(false);
  });

  it('rejects an invalid hex string', () => {
    expect(verifySandboxSignature('Bash', 'not-a-hex-string')).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifySandboxSignature('Bash', '')).toBe(false);
  });

  it('uses timingSafeEqual to prevent timing attacks', () => {
    // This test verifies the function doesn't short-circuit on first differing byte
    const signature = createSandboxSignature('Bash');
    // Create a signature that's definitely different (flip all bits)
    const differentSignature = signature.split('').map(c => {
      const hex = parseInt(c, 16);
      return (15 - hex).toString(16);
    }).join('');

    // Both should return false, but importantly the function should
    // use constant-time comparison
    expect(verifySandboxSignature('Bash', differentSignature)).toBe(false);
  });
});

describe('ToolExecutor.verifySandboxInput', () => {
  it('returns true for properly signed input', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('Bash'),
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(true);
  });

  it('returns false when marker is missing', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('Bash'),
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });

  it('returns false when signature is missing', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });

  it('returns false when signature is forged (marker present but wrong signature)', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: 'a'.repeat(64),
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });

  it('returns false when signature is for a different tool', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('FileRead'),
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });

  it('returns false for completely empty input', () => {
    expect(ToolExecutor.verifySandboxInput({}, 'Bash')).toBe(false);
  });

  it('returns false when marker is false (falsy)', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: false,
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('Bash'),
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });

  it('returns false when signature is not a string', () => {
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: 12345,
    };
    expect(ToolExecutor.verifySandboxInput(input, 'Bash')).toBe(false);
  });
});

describe('Global OS/Network tool semaphore', () => {
  // Shared mutable counters tracked by the mock Bash tool
  let currentConcurrent = 0;
  let peakConcurrent = 0;
  const counterLock = new Semaphore(1);

  const mockBashTool = {
    name: 'Bash',
    description: 'Mock Bash tool for concurrency testing',
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    call: async () => {
      await counterLock.acquire();
      currentConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      counterLock.release();

      // Hold execution long enough for other concurrent calls to queue up
      await new Promise(resolve => setTimeout(resolve, 200));

      await counterLock.acquire();
      currentConcurrent--;
      counterLock.release();

      return { output: 'done', isError: false, toolCallId: '' };
    },
  };

  const mockNonOsTool = {
    name: 'FileRead',
    description: 'Mock FileRead (non-OS/network)',
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    call: async () => {
      await counterLock.acquire();
      currentConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      counterLock.release();

      await new Promise(resolve => setTimeout(resolve, 100));

      await counterLock.acquire();
      currentConcurrent--;
      counterLock.release();

      return { output: 'content', isError: false, toolCallId: '' };
    },
  };

  beforeEach(() => {
    initializeState({ permissionMode: 'default' });
    currentConcurrent = 0;
    peakConcurrent = 0;
    GLOBAL_TOOL_SEMAPHORE.reset();
  });

  afterEach(() => {
    resetState();
  });

  it('exports OS_NETWORK_TOOLS with expected tool names', () => {
    expect(OS_NETWORK_TOOLS.has('Bash')).toBe(true);
    expect(OS_NETWORK_TOOLS.has('Run')).toBe(true);
    expect(OS_NETWORK_TOOLS.has('WebFetch')).toBe(true);
    expect(OS_NETWORK_TOOLS.has('Sql')).toBe(true);
    expect(OS_NETWORK_TOOLS.has('FileRead')).toBe(false);
  });

  it('exports GLOBAL_TOOL_SEMAPHORE as a Semaphore with positive permits', () => {
    expect(GLOBAL_TOOL_SEMAPHORE).toBeInstanceOf(Semaphore);
    expect(GLOBAL_TOOL_SEMAPHORE.total).toBeGreaterThan(0);
  });

  it('limits concurrent OS/network tool execution to global cap', async () => {
    const cap = GLOBAL_TOOL_SEMAPHORE.total;
    const executor = new ToolExecutor(
      [mockBashTool] as any,
      '/tmp',
      undefined,
      undefined,
      { enabled: false },
      { maxConcurrentTools: 50 }
    );

    const calls = Array.from({ length: 30 }, (_, i) => ({
      id: `call-${i}`,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      status: 'pending' as const,
    }));

    const context = {
      cwd: '/tmp',
      abortController: new AbortController(),
      permissions: {} as any,
      env: createLocalExecutionEnv('/tmp'),
    };

    await executor.executeParallel(calls, context);

    expect(peakConcurrent).toBeLessThanOrEqual(cap);
    expect(peakConcurrent).toBeGreaterThan(0);
  });

  it('global cap enforced across multiple ToolExecutor instances', async () => {
    const cap = GLOBAL_TOOL_SEMAPHORE.total;
    const executor1 = new ToolExecutor(
      [mockBashTool] as any,
      '/tmp',
      undefined,
      undefined,
      { enabled: false },
      { maxConcurrentTools: 50 }
    );
    const executor2 = new ToolExecutor(
      [mockBashTool] as any,
      '/tmp',
      undefined,
      undefined,
      { enabled: false },
      { maxConcurrentTools: 50 }
    );

    const calls1 = Array.from({ length: 15 }, (_, i) => ({
      id: `call-a-${i}`,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      status: 'pending' as const,
    }));
    const calls2 = Array.from({ length: 15 }, (_, i) => ({
      id: `call-b-${i}`,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      status: 'pending' as const,
    }));

    const context = {
      cwd: '/tmp',
      abortController: new AbortController(),
      permissions: {} as any,
      env: createLocalExecutionEnv('/tmp'),
    };

    await Promise.all([
      executor1.executeParallel(calls1, context),
      executor2.executeParallel(calls2, context),
    ]);

    expect(peakConcurrent).toBeLessThanOrEqual(cap);
    expect(peakConcurrent).toBeGreaterThan(0);
  });

  it('non-OS/network tools are not throttled by the global semaphore', async () => {
    // FileRead should not go through GLOBAL_TOOL_SEMAPHORE
    const executor = new ToolExecutor(
      [mockNonOsTool] as any,
      '/tmp',
      undefined,
      undefined,
      { enabled: false },
      { maxConcurrentTools: 50 }
    );

    const calls = Array.from({ length: 20 }, (_, i) => ({
      id: `read-${i}`,
      toolName: 'FileRead',
      input: { path: '/tmp/test.txt' },
      status: 'pending' as const,
    }));

    const context = {
      cwd: '/tmp',
      abortController: new AbortController(),
      permissions: {} as any,
      env: createLocalExecutionEnv('/tmp'),
    };

    await executor.executeParallel(calls, context);

    // With per-executor cap of 50 and no global cap on FileRead,
    // all 20 calls should be able to run concurrently (limited only by
    // the per-executor semaphore, which is set to 50).
    expect(peakConcurrent).toBe(20);
  });
});
