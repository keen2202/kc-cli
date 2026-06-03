/**
 * Stateful parser for extracting <thinking>...</thinking> tags from streamed text.
 * Handles tags that span multiple chunks. Used by providers with supportsChainOfThought.
 */
export class ThinkingTagParser {
  private inThinking = false;
  private thinkingBuffer = '';

  /**
   * Process a text chunk and yield normalized events.
   * Splits on <thinking> and </thinking> tags, handling partial tags across chunks.
   */
  *process(text: string): Generator<{ type: 'text_delta' | 'thinking_delta'; content: string }> {
    let remaining = text;

    while (remaining.length > 0) {
      if (!this.inThinking) {
        const openIdx = remaining.indexOf('<thinking>');
        if (openIdx === -1) {
          // No thinking tag — yield entire chunk as text
          if (remaining) {
            yield { type: 'text_delta', content: remaining };
          }
          return;
        }

        // Yield text before the tag
        if (openIdx > 0) {
          yield { type: 'text_delta', content: remaining.slice(0, openIdx) };
        }

        // Enter thinking mode
        this.inThinking = true;
        this.thinkingBuffer = '';
        remaining = remaining.slice(openIdx + '<thinking>'.length);
      } else {
        const closeIdx = remaining.indexOf('</thinking>');
        if (closeIdx === -1) {
          // No closing tag yet — buffer everything as thinking
          this.thinkingBuffer += remaining;
          yield { type: 'thinking_delta', content: remaining };
          return;
        }

        // Found closing tag — emit thinking content and switch back to text mode
        const thinkingChunk = remaining.slice(0, closeIdx);
        if (thinkingChunk) {
          this.thinkingBuffer += thinkingChunk;
          yield { type: 'thinking_delta', content: thinkingChunk };
        }

        this.inThinking = false;
        remaining = remaining.slice(closeIdx + '</thinking>'.length);
      }
    }
  }

  /** Reset parser state (e.g., between turns) */
  reset(): void {
    this.inThinking = false;
    this.thinkingBuffer = '';
  }
}
