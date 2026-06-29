import type { ChatMessage, AssistantMessage, TurnImportance, TurnTag } from './protocol';

/**
 * Auto-tagging heuristics engine.
 * Classifies each conversation turn by importance for smart compaction decisions.
 */
export class ImportanceTagger {
  /** Tag a single turn's assistant response. */
  tagTurn(
    assistantMsg: AssistantMessage,
    toolNames: string[],
    toolOutputs: string[],
    turnIndex: number,
    modifiedFiles: string[]
  ): TurnTag {
    const combinedOutput = toolOutputs.join('\n');
    const importance = this.classifyImportance(assistantMsg, combinedOutput, toolNames);

    return {
      importance,
      keywords: this.extractKeywords(combinedOutput),
      filePaths: this.extractFilePaths(assistantMsg, toolOutputs),
      testOutput: this.extractTestOutput(combinedOutput),
      applied: toolNames.includes('write') || toolNames.includes('edit'),
    };
  }

  private classifyImportance(
    msg: AssistantMessage,
    output: string,
    toolNames: string[]
  ): TurnImportance {
    // key_finding: test failures, errors, stack traces
    if (/Error:|FAILED|AssertionError|Traceback|assert.*failed/i.test(output)) {
      return 'key_finding';
    }

    // key_finding: first time a test is run and produces structured output
    if (/=+ test session starts =+|PASSED|FAILED|ERRORS/i.test(output)) {
      return 'key_finding';
    }

    // failed_attempt: agent acknowledges wrong approach
    const content = msg.content || '';
    if (/(let me revert|that didn.t work|wrong approach|undo|rollback|no that.s wrong)/i.test(content)) {
      return 'failed_attempt';
    }

    // failed_attempt: write/edit followed by revert-like content within same turn
    if (
      (toolNames.includes('write') || toolNames.includes('edit')) &&
      /(didn.t work|wrong|revert|undo)/i.test(content + output)
    ) {
      return 'failed_attempt';
    }

    // exploration: file reads, greps, globs (default)
    return 'exploration';
  }

  /**
   * Check if a read of the same file qualifies as a duplicate (redundant).
   * Returns true if file was already read within the last `window` turns
   * with no intervening write/edit.
   */
  isDuplicateRead(
    filePath: string,
    currentTurn: number,
    readHistory: Map<string, number>,
    editHistory: Map<string, number>,
    window = 3
  ): boolean {
    const lastRead = readHistory.get(filePath);
    if (lastRead === undefined || (currentTurn - lastRead) > window) {
      return false;
    }
    const lastEdit = editHistory.get(filePath);
    if (lastEdit !== undefined && lastEdit > lastRead) {
      return false; // file was edited since last read
    }
    return true;
  }

  private extractKeywords(output: string): string[] {
    const words = output.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) || [];
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'will', 'when', 'what', 'which', 'where', 'there', 'their']);
    return [...new Set(words.filter(w => !stopWords.has(w.toLowerCase())))].slice(0, 20);
  }

  private extractFilePaths(msg: AssistantMessage, outputs: string[]): string[] {
    const combined = [msg.content || '', ...outputs].join('\n');
    const matches = combined.match(/[\w./-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|rb)/g) || [];
    return [...new Set(matches)].slice(0, 15);
  }

  private extractTestOutput(output: string): string | undefined {
    const match = output.match(/(FAILED|ERRORS|assert.*|Error:[\s\S]*?)(?=\n\n|\n[=]{5,}|$)/i);
    return match ? match[0].slice(0, 500) : undefined;
  }
}
