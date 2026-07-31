// Tests for /branch, /checkout, /history command handlers

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBranch, handleCheckout, handleHistory } from '../../src/commands/branch';
import type { QueryEngine } from '../../src/query/QueryEngine';

interface FakeNode {
  id: string;
  parentId: string | null;
  label?: string;
  messages: unknown[];
}

function makeEngine(tree: FakeNode[], options: {
  branchReturns?: string;
  checkoutThrows?: Error;
  messages?: unknown[];
} = {}) {
  const setBranchLabel = vi.fn();
  const checkout = vi.fn(() => {
    if (options.checkoutThrows) throw options.checkoutThrows;
  });
  const engine = {
    getTree: () => tree,
    getMessages: () => options.messages ?? [],
    branch: vi.fn(() => options.branchReturns ?? 'branch-id'),
    checkout,
    getSessionTree: () => ({ setBranchLabel }),
  } as unknown as QueryEngine;
  return { engine, setBranchLabel, checkout };
}

const ROOT: FakeNode = { id: 'aaaa1111-root', parentId: null, messages: [{}, {}] };
const CHILD: FakeNode = { id: 'bbbb2222-child', parentId: 'aaaa1111-root', label: 'feature', messages: [{}] };

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function logged(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('handleBranch', () => {
  it('lists branches when called without a label', () => {
    const { engine } = makeEngine([ROOT, CHILD]);
    handleBranch(engine);
    expect(logged()).toContain('Branches:');
    expect(logged()).toContain('bbbb2222');
    expect(logged()).toContain('[feature]');
  });

  it('creates a branch and applies the label', () => {
    const newNode: FakeNode = { id: 'cccc3333-new', parentId: 'aaaa1111-root', messages: [] };
    const { engine, setBranchLabel } = makeEngine([ROOT, newNode], { branchReturns: newNode.id });
    handleBranch(engine, 'experiment');
    expect(setBranchLabel).toHaveBeenCalledWith(newNode.id, 'experiment');
    expect(logged()).toContain('Created branch');
    expect(logged()).toContain('experiment');
  });
});

describe('handleCheckout', () => {
  it('switches to a branch by exact id', () => {
    const { engine, checkout } = makeEngine([ROOT, CHILD]);
    handleCheckout(engine, CHILD.id);
    expect(checkout).toHaveBeenCalledWith(CHILD.id);
    expect(logged()).toContain('Switched to branch');
  });

  it('switches to a branch by prefix match', () => {
    const { engine, checkout } = makeEngine([ROOT, CHILD]);
    handleCheckout(engine, 'bbbb');
    expect(checkout).toHaveBeenCalledWith(CHILD.id);
  });

  it('reports an unknown branch id without calling checkout', () => {
    const { engine, checkout } = makeEngine([ROOT, CHILD]);
    handleCheckout(engine, 'zzzz');
    expect(checkout).not.toHaveBeenCalled();
    expect(logged()).toContain('Branch not found');
  });

  it('surfaces checkout errors instead of throwing', () => {
    const { engine } = makeEngine([ROOT, CHILD], { checkoutThrows: new Error('detached head') });
    expect(() => handleCheckout(engine, CHILD.id)).not.toThrow();
    expect(logged()).toContain('detached head');
  });
});

describe('handleHistory', () => {
  it('reports when there is no conversation history', () => {
    const { engine } = makeEngine([]);
    handleHistory(engine);
    expect(logged()).toContain('No conversation history');
  });

  it('prints the conversation tree with the active leaf marked', () => {
    // Active leaf = the one whose root-to-leaf chain length matches getMessages().
    const { engine } = makeEngine([ROOT, CHILD], { messages: [{}, {}, {}] });
    handleHistory(engine);
    const output = logged();
    expect(output).toContain('Conversation Tree:');
    expect(output).toContain('aaaa1111');
    expect(output).toContain('bbbb2222');
    expect(output).toContain('active');
  });
});
