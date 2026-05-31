import { describe, it, expect } from 'vitest';
import { SessionTree } from '../../src/state/session-tree';
import type { ChatMessage } from '../../src/types/message';

function makeMsg(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    timestamp: Date.now(),
  } as ChatMessage;
}

describe('SessionTree', () => {
  describe('construction', () => {
    it('creates a tree with empty root when no messages given', () => {
      const tree = new SessionTree();
      const nodes = tree.getTree();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].parentId).toBeNull();
      expect(nodes[0].messages).toEqual([]);
      expect(tree.getActiveNodeId()).toBe(nodes[0].id);
    });

    it('creates a tree with root messages', () => {
      const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
      const tree = new SessionTree(msgs);
      expect(tree.getActiveMessages()).toEqual(msgs);
      expect(tree.getTree()).toHaveLength(1);
    });
  });

  describe('branch', () => {
    it('creates a new branch from the active node', () => {
      const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
      const tree = new SessionTree(msgs);
      const rootId = tree.getActiveNodeId();

      const branchId = tree.branch();
      expect(branchId).not.toBe(rootId);
      expect(tree.getActiveNodeId()).toBe(branchId);

      const branchNode = tree.getNode(branchId)!;
      expect(branchNode.parentId).toBe(rootId);
      expect(branchNode.branchPoint).toBe(2);
      expect(branchNode.messages).toEqual([]);
    });

    it('inherits ancestor messages when getting active messages', () => {
      const rootMsgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
      const tree = new SessionTree(rootMsgs);
      tree.branch();

      const branchMsg = makeMsg('user', 'branch question');
      // Directly push to the active node's messages for testing
      const activeNode = tree.getNode(tree.getActiveNodeId())!;
      activeNode.messages.push(branchMsg);

      const active = tree.getActiveMessages();
      expect(active).toHaveLength(3);
      expect(active[0].content).toBe('hello');
      expect(active[1].content).toBe('hi');
      expect(active[2].content).toBe('branch question');
    });

    it('creates a branch from a specified node', () => {
      const tree = new SessionTree([makeMsg('user', 'a')]);
      const rootId = tree.getActiveNodeId();
      const branch1 = tree.branch();

      // Now create branch from root, not from branch1
      const branch2 = tree.branch(rootId);
      expect(tree.getNode(branch2)!.parentId).toBe(rootId);
      expect(tree.getNode(branch2)!.branchPoint).toBe(1);
    });

    it('throws when branching from nonexistent node', () => {
      const tree = new SessionTree();
      expect(() => tree.branch('nonexistent')).toThrow('Node nonexistent not found');
    });
  });

  describe('checkout', () => {
    it('switches the active branch', () => {
      const tree = new SessionTree([makeMsg('user', 'hello')]);
      const rootId = tree.getActiveNodeId();
      const branchId = tree.branch();

      tree.checkout(rootId);
      expect(tree.getActiveNodeId()).toBe(rootId);

      tree.checkout(branchId);
      expect(tree.getActiveNodeId()).toBe(branchId);
    });

    it('throws when checking out nonexistent node', () => {
      const tree = new SessionTree();
      expect(() => tree.checkout('nonexistent')).toThrow('Node nonexistent not found');
    });
  });

  describe('getActiveMessages', () => {
    it('returns empty array for empty root', () => {
      const tree = new SessionTree();
      expect(tree.getActiveMessages()).toEqual([]);
    });

    it('walks tree correctly with multiple levels', () => {
      const tree = new SessionTree([makeMsg('user', 'root msg')]);
      tree.branch();
      // Add msg to first branch
      const active1 = tree.getNode(tree.getActiveNodeId())!;
      active1.messages.push(makeMsg('assistant', 'branch1 reply'));

      // Branch again
      tree.branch();
      const active2 = tree.getNode(tree.getActiveNodeId())!;
      active2.messages.push(makeMsg('user', 'branch2 msg'));

      const messages = tree.getActiveMessages();
      expect(messages.map(m => m.content)).toEqual([
        'root msg',
        'branch1 reply',
        'branch2 msg',
      ]);
    });
  });

  describe('prune', () => {
    it('removes a node and reassigns active to parent', () => {
      const tree = new SessionTree([makeMsg('user', 'hello')]);
      const rootId = tree.getActiveNodeId();
      const branchId = tree.branch();

      tree.prune(branchId);
      expect(tree.getNode(branchId)).toBeUndefined();
      expect(tree.getActiveNodeId()).toBe(rootId);
      expect(tree.getTree()).toHaveLength(1);
    });

    it('removes descendants recursively', () => {
      const tree = new SessionTree([makeMsg('user', 'a')]);
      const branch1 = tree.branch();
      const branch2 = tree.branch(); // child of branch1

      tree.checkout(branch1);
      tree.prune(branch1);
      expect(tree.getNode(branch1)).toBeUndefined();
      expect(tree.getNode(branch2)).toBeUndefined();
    });

    it('throws when pruning root', () => {
      const tree = new SessionTree();
      expect(() => tree.prune(tree.getActiveNodeId())).toThrow('Cannot prune the root node');
    });

    it('throws when pruning nonexistent node', () => {
      const tree = new SessionTree();
      expect(() => tree.prune('nonexistent')).toThrow('Node nonexistent not found');
    });
  });

  describe('merge', () => {
    it('merges a branch messages into parent', () => {
      const rootMsgs = [makeMsg('user', 'question')];
      const tree = new SessionTree(rootMsgs);
      const rootId = tree.getActiveNodeId();

      const branchId = tree.branch();
      const branchNode = tree.getNode(branchId)!;
      branchNode.messages.push(makeMsg('assistant', 'answer'));

      tree.merge(branchId);

      const rootNode = tree.getNode(rootId)!;
      expect(rootNode.messages.map(m => m.content)).toEqual(['question', 'answer']);
      expect(tree.getNode(branchId)).toBeUndefined();
      expect(tree.getActiveNodeId()).toBe(rootId);
    });

    it('re-parents children of merged node', () => {
      const tree = new SessionTree([makeMsg('user', 'a')]);
      const rootId = tree.getActiveNodeId();
      const branch1 = tree.branch();
      tree.getNode(branch1)!.messages.push(makeMsg('assistant', 'b'));
      const branch2 = tree.branch(); // child of branch1

      tree.merge(branch1);

      // branch2 should now be a child of root
      const b2 = tree.getNode(branch2)!;
      expect(b2.parentId).toBe(rootId);
    });

    it('throws when merging root', () => {
      const tree = new SessionTree();
      expect(() => tree.merge(tree.getActiveNodeId())).toThrow('Cannot merge the root node');
    });

    it('throws when merging nonexistent node', () => {
      const tree = new SessionTree();
      expect(() => tree.merge('nonexistent')).toThrow('Node nonexistent not found');
    });
  });

  describe('getChildren', () => {
    it('returns direct children of a node', () => {
      const tree = new SessionTree([makeMsg('user', 'a')]);
      const rootId = tree.getActiveNodeId();
      const branch1 = tree.branch(rootId);
      const branch2 = tree.branch(rootId);

      const children = tree.getChildren(rootId);
      expect(children.map(c => c.id).sort()).toEqual([branch1, branch2].sort());
    });

    it('returns empty array for leaf node', () => {
      const tree = new SessionTree();
      tree.branch();
      expect(tree.getChildren(tree.getActiveNodeId())).toEqual([]);
    });
  });

  describe('label and summary', () => {
    it('sets and gets label', () => {
      const tree = new SessionTree();
      const rootId = tree.getActiveNodeId();
      tree.setBranchLabel(rootId, 'main');
      expect(tree.getNode(rootId)!.label).toBe('main');
    });

    it('gets branch summary', () => {
      const tree = new SessionTree();
      const rootId = tree.getActiveNodeId();
      const node = tree.getNode(rootId)!;
      node.summary = 'test summary';
      expect(tree.getBranchSummary(rootId)).toBe('test summary');
    });

    it('returns undefined for nonexistent node summary', () => {
      const tree = new SessionTree();
      expect(tree.getBranchSummary('nonexistent')).toBeUndefined();
    });

    it('throws when setting label on nonexistent node', () => {
      const tree = new SessionTree();
      expect(() => tree.setBranchLabel('nonexistent', 'x')).toThrow('Node nonexistent not found');
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const tree = new SessionTree([makeMsg('user', 'hello')]);
      const rootId = tree.getActiveNodeId();
      const branchId = tree.branch();
      tree.getNode(branchId)!.messages.push(makeMsg('assistant', 'reply'));
      tree.setBranchLabel(branchId, 'feature-branch');

      const json = tree.toJSON();
      const restored = SessionTree.fromJSON(json);

      expect(restored.getActiveNodeId()).toBe(tree.getActiveNodeId());
      expect(restored.getTree()).toHaveLength(2);
      expect(restored.getNode(branchId)!.label).toBe('feature-branch');

      // Verify message reconstruction
      tree.checkout(branchId);
      restored.checkout(branchId);
      expect(restored.getActiveMessages()).toEqual(tree.getActiveMessages());
    });

    it('round-trips empty tree', () => {
      const tree = new SessionTree();
      const json = tree.toJSON();
      const restored = SessionTree.fromJSON(json);
      expect(restored.getTree()).toHaveLength(1);
      expect(restored.getActiveMessages()).toEqual([]);
    });
  });
});
