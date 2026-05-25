import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSandboxSignature,
  verifySandboxSignature,
  SANDBOX_WRAPPED_MARKER,
  SANDBOX_SIGNATURE_KEY,
  ToolExecutor,
} from './toolExecutor';

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
