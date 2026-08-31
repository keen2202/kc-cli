// QueryEngine conversation state management

import type { ChatMessage, TurnTag, MessageWithTag } from '../query/protocol';
import { estimateMessageTokens, estimateMessageTokensArray } from '../utils/tokenEstimation';
import { SessionTree, type SessionNode } from '../state/session-tree';

/**
 * Configuration for conversation state management.
 */
export interface ConversationStateConfig {
  /** Maximum number of messages to keep */
  maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 200;

/**
 * Manages conversation state for QueryEngine.
 * Handles message storage, token estimation caching, and message trimming.
 *
 * Internally uses a SessionTree for non-linear branching support.
 * The public API is preserved for backward compatibility.
 */
export class ConversationState {
  /**
   * Backward-compatible reference to the active node's messages array.
   * Tests and external code that access this property directly (via `(engine as any).messages`)
   * will still work. This reference is updated when the active branch changes.
   */
  messages: ChatMessage[] = [];
  private tree: SessionTree;
  private runningTokenTotal: number = 0;
  private recomputed: boolean = true;
  private maxMessages: number;
  private turnTags = new Map<string, TurnTag>();

  /**
   * Monotonic version of the active transcript. Bumped on every mutation so
   * derived caches (e.g. the built API-messages array) can validate freshness
   * in O(1).
   */
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }

  constructor(config: ConversationStateConfig = {}) {
    this.maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.tree = new SessionTree();
    this.messages = this.getActiveNodeMessages();
    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
  }

  /** Get the messages array of the active tree node */
  private getActiveNodeMessages(): ChatMessage[] {
    const node = this.tree.getNode(this.tree.getActiveNodeId());
    return node ? node.messages : [];
  }

  /** Synchronize the messages reference with the active node */
  private syncMessagesRef(): void {
    this.messages = this.getActiveNodeMessages();
  }

  /** Add a message to the conversation (appends to active branch) */
  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    // Also update the tree node's messages in case this.messages was synced from getActiveMessages()
    const activeNode = this.tree.getNode(this.tree.getActiveNodeId());
    if (activeNode && activeNode.messages !== this.messages) {
      activeNode.messages.push(msg);
    }
    this.runningTokenTotal += estimateMessageTokens(msg);
    this.recomputed = false;
    this.versionCounter++;
  }

  /** Get all messages for the active branch (reconstructs root→active path) */
  getMessages(): ChatMessage[] {
    const allMessages = this.tree.getActiveMessages();
    // Sync this.messages for backward compat with code that accesses it directly
    this.messages = allMessages;
    return allMessages;
  }

  /** Get a copy of all messages for the active branch */
  getMessagesCopy(): ChatMessage[] {
    return [...this.messages];
  }

  /** Set all messages (e.g., after compaction) -- replaces active branch messages */
  setMessages(messages: ChatMessage[]): void {
    const activeNode = this.tree.getNode(this.tree.getActiveNodeId());
    if (activeNode) {
      activeNode.messages = messages;
    }
    this.messages = messages;
    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
    this.versionCounter++;
  }

  /** Get the last message in the active branch */
  getLastMessage(): ChatMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  /** Clear all messages -- creates a fresh tree */
  clear(): void {
    this.tree = new SessionTree();
    this.messages = this.getActiveNodeMessages();
    this.runningTokenTotal = 0;
    this.recomputed = true;
    this.versionCounter++;
  }

  /** Get the number of messages in the active branch */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Get or compute the token estimate (cached) */
  getTokenEstimate(): number {
    return this.runningTokenTotal;
  }

  /** Invalidate the cached token estimate */
  invalidateTokenEstimate(): void {
    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
  }

  /** Find the last user message in the active branch */
  findLastUserMessage(): ChatMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') return this.messages[i];
    }
    return undefined;
  }

  /** Tag a message with importance metadata for compaction decisions */
  tagMessage(messageId: string, tag: TurnTag): void {
    this.turnTags.set(messageId, tag);
  }

  /** Get the tag for a message, if any */
  getTag(messageId: string): TurnTag | undefined {
    return this.turnTags.get(messageId);
  }

  /** Get all messages with their tags for compaction decisions */
  getMessagesWithTags(): MessageWithTag[] {
    return this.messages.map((msg, i) => ({
      message: msg,
      tag: this.turnTags.get(msg.id) || {
        importance: 'exploration' as const,
        keywords: [],
        filePaths: [],
        applied: false,
      },
      turnIndex: i,
    }));
  }

  /** Trim messages to stay within the max limit, protecting anchor messages */
  trimIfNeeded(): number {
    if (this.messages.length <= this.maxMessages) {
      return 0;
    }

    let firstSystemIdx = -1;
    let firstUserIdx = -1;
    for (let i = 0; i < this.messages.length; i++) {
      if (firstSystemIdx === -1 && this.messages[i].role === 'system') firstSystemIdx = i;
      if (firstUserIdx === -1 && this.messages[i].role === 'user') firstUserIdx = i;
      if (firstSystemIdx !== -1 && firstUserIdx !== -1) break;
    }

    const excess = this.messages.length - this.maxMessages;

    if (firstSystemIdx === -1 && firstUserIdx === -1) {
      this.messages = this.messages.slice(excess);
    } else {
      const protectedIndices = new Set<number>();
      if (firstSystemIdx !== -1) protectedIndices.add(firstSystemIdx);
      if (firstUserIdx !== -1) protectedIndices.add(firstUserIdx);

      const removable: number[] = [];
      for (let i = 0; i < this.messages.length; i++) {
        if (!protectedIndices.has(i)) removable.push(i);
      }

      if (removable.length >= excess) {
        const toRemove = new Set(removable.slice(0, excess));
        this.messages = this.messages.filter((_, idx) => !toRemove.has(idx));
      } else {
        this.messages = this.messages.slice(excess);
      }
    }

    // Update the tree node's messages to match
    const activeNode = this.tree.getNode(this.tree.getActiveNodeId());
    if (activeNode) {
      activeNode.messages = this.messages;
    }

    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
    this.versionCounter++;
    return excess;
  }

  // --- Branching methods (new) ---

  /** Create a new branch from the active node. Returns the new branch node ID. */
  branch(): string {
    const nodeId = this.tree.branch();
    this.syncMessagesRef();
    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
    this.versionCounter++;
    return nodeId;
  }

  /** Switch to a different branch by node ID. */
  checkout(nodeId: string): void {
    this.tree.checkout(nodeId);
    this.syncMessagesRef();
    this.runningTokenTotal = estimateMessageTokensArray(this.messages);
    this.recomputed = true;
    this.versionCounter++;
  }

  /** Get the full tree structure. */
  getTree(): SessionNode[] {
    return this.tree.getTree();
  }

  /** Get the underlying SessionTree (for advanced operations). */
  getSessionTree(): SessionTree {
    return this.tree;
  }
}
