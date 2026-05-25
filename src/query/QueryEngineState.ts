// QueryEngine conversation state management

import type { ChatMessage } from '../types/message';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';

/**
 * Configuration for conversation state management.
 */
export interface ConversationStateConfig {
  /** Maximum number of messages to keep */
  maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 1000;

/**
 * Manages conversation state for QueryEngine.
 * Handles message storage, token estimation caching, and message trimming.
 */
export class ConversationState {
  private messages: ChatMessage[] = [];
  private cachedTokenEstimate: number | null = null;
  private maxMessages: number;

  constructor(config: ConversationStateConfig = {}) {
    this.maxMessages = config.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  /** Add a message to the conversation */
  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.cachedTokenEstimate = null;
  }

  /** Get all messages */
  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Get a copy of all messages */
  getMessagesCopy(): ChatMessage[] {
    return [...this.messages];
  }

  /** Set all messages (e.g., after compaction) */
  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    this.cachedTokenEstimate = null;
  }

  /** Get the last message */
  getLastMessage(): ChatMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  /** Clear all messages */
  clear(): void {
    this.messages = [];
    this.cachedTokenEstimate = null;
  }

  /** Get the number of messages */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Get or compute the token estimate (cached) */
  getTokenEstimate(): number {
    if (this.cachedTokenEstimate === null) {
      this.cachedTokenEstimate = estimateMessageTokensArray(this.messages);
    }
    return this.cachedTokenEstimate;
  }

  /** Invalidate the cached token estimate */
  invalidateTokenEstimate(): void {
    this.cachedTokenEstimate = null;
  }

  /** Find the last user message */
  findLastUserMessage(): ChatMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') return this.messages[i];
    }
    return undefined;
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

    this.cachedTokenEstimate = null;
    return excess;
  }
}
