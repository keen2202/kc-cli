// DockerTool Tests — SEC-01 command injection prevention

import { describe, it, expect } from 'vitest';
import { tool as DockerTool } from '../../src/tools/DockerTool/index.js';

function makeCtx() {
  return { cwd: process.cwd(), abortController: new AbortController() } as any;
}

describe('DockerTool security', () => {
  it('should reject command injection via semicolon', () => {
    const result = DockerTool.checkPermissions!({ command: 'ps; rm -rf /', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject command injection via pipe', () => {
    const result = DockerTool.checkPermissions!({ command: 'ps | sh', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject command injection via backticks', () => {
    const result = DockerTool.checkPermissions!({ command: 'ps `echo injected`', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject rm -rf directly', () => {
    const result = DockerTool.checkPermissions!({ command: 'rm -rf mycontainer', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject rm -r (recursive remove without force)', () => {
    const result = DockerTool.checkPermissions!({ command: 'rm -r mycontainer', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject rm --force', () => {
    const result = DockerTool.checkPermissions!({ command: 'rm --force mycontainer', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject image prune (destructive)', () => {
    const result = DockerTool.checkPermissions!({ command: 'image prune -a', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should reject container prune (destructive)', () => {
    const result = DockerTool.checkPermissions!({ command: 'container prune', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('deny');
  });

  it('should allow legitimate ps command', () => {
    const result = DockerTool.checkPermissions!({ command: 'ps', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('allow');
  });

  it('should allow legitimate images command', () => {
    const result = DockerTool.checkPermissions!({ command: 'images', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('allow');
  });

  it('should ask for non-readonly, non-dangerous commands', () => {
    const result = DockerTool.checkPermissions!({ command: 'start mycontainer', timeout: 60 }, makeCtx());
    expect(result.behavior).toBe('ask');
  });

  it('should have correct tool metadata', () => {
    expect(DockerTool.name).toBe('Docker');
    expect(DockerTool.description).toBeDefined();
    expect(DockerTool.inputSchema).toBeDefined();
  });
});
