// Session tree for non-linear conversation branching

import { randomUUID } from 'crypto';
import type { ChatMessage } from '../types/message';

export interface SessionNode {
  id: string;
  parentId: string | null;
  messages: ChatMessage[];
  branchPoint: number;  // Index in parent's messages where this branch starts
  summary?: string;     // Auto-generated branch summary
  label?: string;       // Human-readable label
  createdAt: number;
}

interface SerializedSessionTree {
  nodes: Array<[string, SessionNode]>;
  activeBranchId: string;
}

/**
 * Tree data structure for managing non-linear conversation branches.
 * Each node holds a slice of messages from its branch point.
 * Walking from root to a leaf reconstructs the full conversation for that branch.
 */
export class SessionTree {
  private nodes: Map<string, SessionNode> = new Map();
  private activeBranchId: string;

  constructor(rootMessages: ChatMessage[] = []) {
    const rootId = randomUUID();
    this.nodes.set(rootId, {
      id: rootId,
      parentId: null,
      messages: [...rootMessages],
      branchPoint: 0,
      createdAt: Date.now(),
    });
    this.activeBranchId = rootId;
  }

  /**
   * Create a new branch from the active node (or specified node).
   * The new branch inherits messages up to the branch point from its parent.
   * Returns the new node's ID.
   */
  branch(fromNodeId?: string): string {
    const parentId = fromNodeId ?? this.activeBranchId;
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new Error(`Node ${parentId} not found`);
    }

    const childId = randomUUID();
    this.nodes.set(childId, {
      id: childId,
      parentId: parent.id,
      messages: [],  // New branch starts with no additional messages
      branchPoint: parent.messages.length,
      createdAt: Date.now(),
    });
    this.activeBranchId = childId;
    return childId;
  }

  /**
   * Switch the active branch to the given node.
   */
  checkout(nodeId: string): void {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} not found`);
    }
    this.activeBranchId = nodeId;
  }

  /**
   * Get messages for the active branch by walking from root to active node.
   * Collects all ancestor messages plus the active node's own messages.
   */
  getActiveMessages(): ChatMessage[] {
    return this.getMessagesForNode(this.activeBranchId);
  }

  /**
   * Get messages for any node by walking from root to that node.
   */
  getMessagesForNode(nodeId: string): ChatMessage[] {
    const chain = this.getNodeChain(nodeId);
    const messages: ChatMessage[] = [];
    for (const node of chain) {
      messages.push(...node.messages);
    }
    return messages;
  }

  /**
   * Get the active branch node ID.
   */
  getActiveNodeId(): string {
    return this.activeBranchId;
  }

  /**
   * Get branch summary for a node.
   */
  getBranchSummary(nodeId: string): string | undefined {
    return this.nodes.get(nodeId)?.summary;
  }

  /**
   * Set branch label for a node.
   */
  setBranchLabel(nodeId: string, label: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    node.label = label;
  }

  /**
   * Delete a node and all its descendants. Cannot prune the root.
   */
  prune(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    if (node.parentId === null) {
      throw new Error('Cannot prune the root node');
    }

    // Collect all descendants to remove
    const toRemove = this.getDescendantIds(nodeId);
    toRemove.push(nodeId);

    // If the active branch is being pruned, switch to parent
    if (toRemove.includes(this.activeBranchId)) {
      this.activeBranchId = node.parentId;
    }

    for (const id of toRemove) {
      this.nodes.delete(id);
    }
  }

  /**
   * Merge a branch's messages into its parent.
   * The merged node's messages are appended to the parent, then the node is removed.
   * Children of the merged node are re-parented to the parent.
   */
  merge(fromNodeId: string): void {
    const node = this.nodes.get(fromNodeId);
    if (!node) {
      throw new Error(`Node ${fromNodeId} not found`);
    }
    if (node.parentId === null) {
      throw new Error('Cannot merge the root node');
    }

    const parent = this.nodes.get(node.parentId)!;

    // Append this node's messages to parent
    parent.messages.push(...node.messages);

    // Re-parent children of the merged node to the parent
    for (const [, n] of this.nodes) {
      if (n.parentId === fromNodeId) {
        n.parentId = parent.id;
        // Adjust branchPoint: parent now has more messages
        // The child's branchPoint was relative to the merged node's start,
        // recalculate relative to the new parent
        n.branchPoint = parent.messages.length - node.messages.length + n.branchPoint;
      }
    }

    // If active branch was the merged node, switch to parent
    if (this.activeBranchId === fromNodeId) {
      this.activeBranchId = parent.id;
    }

    this.nodes.delete(fromNodeId);
  }

  /**
   * Get all nodes as an array.
   */
  getTree(): SessionNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get a specific node by ID.
   */
  getNode(nodeId: string): SessionNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get direct children of a node.
   */
  getChildren(nodeId: string): SessionNode[] {
    const children: SessionNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === nodeId) {
        children.push(node);
      }
    }
    return children;
  }

  /**
   * Serialize to JSON for persistence.
   */
  toJSON(): SerializedSessionTree {
    return {
      nodes: Array.from(this.nodes.entries()),
      activeBranchId: this.activeBranchId,
    };
  }

  /**
   * Deserialize from JSON.
   */
  static fromJSON(data: SerializedSessionTree): SessionTree {
    const tree = Object.create(SessionTree.prototype) as SessionTree;
    tree.nodes = new Map(data.nodes);
    tree.activeBranchId = data.activeBranchId;
    return tree;
  }

  // --- Private helpers ---

  /**
   * Walk from a node up to the root, returning the chain from root to node.
   */
  private getNodeChain(nodeId: string): SessionNode[] {
    const chain: SessionNode[] = [];
    let current: SessionNode | undefined = this.nodes.get(nodeId);
    while (current) {
      chain.push(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    chain.reverse();
    return chain;
  }

  /**
   * Get all descendant IDs of a node (recursive).
   */
  private getDescendantIds(nodeId: string): string[] {
    const descendants: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === nodeId) {
        descendants.push(node.id);
        descendants.push(...this.getDescendantIds(node.id));
      }
    }
    return descendants;
  }
}
