// T3 (H3): session-scoped file operation journal.
//
// Records every successful FileWrite/FileEdit (and FileRestore) mutation so the
// FileRestore tool can undo the most recent change or roll a file back to its
// session-start state. The journal is held per QueryEngine instance, so sub
// agents (which run on their own QueryEngine) get isolated histories and never
// cross-contaminate each other's undo stacks.

/** The kind of mutation that produced a journal entry. */
export type FileOperationKind = 'write' | 'edit' | 'restore';

/** A single recorded file mutation. */
export interface FileOperationEntry {
  /** Monotonic sequence number within this journal (1-based). */
  seq: number;
  /** Absolute path of the mutated file. */
  filePath: string;
  /** Which tool/action produced the mutation. */
  operation: FileOperationKind;
  /** File content before the mutation; `null` when the file did not exist. */
  oldContent: string | null;
  /** File content after the mutation; `null` when the file was removed. */
  newContent: string | null;
  /** Path to the T2 `.bak` snapshot taken before the write, if any. */
  backupPath: string | null;
  /** Agent turn during which the mutation happened (0 for tool-initiated). */
  turn: number;
  /** Wall-clock timestamp (ms). */
  ts: number;
}

/** Arguments accepted by {@link FileOperationJournal.record}. */
export interface RecordFileOperationInput {
  filePath: string;
  operation: FileOperationKind;
  oldContent: string | null;
  newContent: string | null;
  backupPath?: string | null;
  turn?: number;
}

/**
 * Minimal journal surface exposed to tools via `ToolUseContext.journal`.
 * Keeping the tool-facing contract narrow avoids leaking mutation helpers into
 * tool code and lets the executor own recording.
 */
export interface FileOperationJournalReader {
  list(): readonly FileOperationEntry[];
  last(): FileOperationEntry | undefined;
  firstForFile(filePath: string): FileOperationEntry | undefined;
  lastForFile(filePath: string): FileOperationEntry | undefined;
  record(input: RecordFileOperationInput): FileOperationEntry;
  size(): number;
}

export class FileOperationJournal implements FileOperationJournalReader {
  private entries: FileOperationEntry[] = [];
  private seqCounter = 0;

  /** Append a mutation to the journal and return the stored entry. */
  record(input: RecordFileOperationInput): FileOperationEntry {
    const entry: FileOperationEntry = {
      seq: ++this.seqCounter,
      filePath: input.filePath,
      operation: input.operation,
      oldContent: input.oldContent,
      newContent: input.newContent,
      backupPath: input.backupPath ?? null,
      turn: input.turn ?? 0,
      ts: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  /** All entries in chronological order (oldest first). */
  list(): readonly FileOperationEntry[] {
    return this.entries;
  }

  /** The most recent entry, or `undefined` when the journal is empty. */
  last(): FileOperationEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** The earliest recorded entry for `filePath` (session-start baseline). */
  firstForFile(filePath: string): FileOperationEntry | undefined {
    return this.entries.find(e => e.filePath === filePath);
  }

  /** The most recent recorded entry for `filePath`. */
  lastForFile(filePath: string): FileOperationEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.filePath === filePath) return this.entries[i];
    }
    return undefined;
  }

  /** Number of recorded entries. */
  size(): number {
    return this.entries.length;
  }

  /** Drop all entries (used when a session/journal scope is reset). */
  clear(): void {
    this.entries = [];
    this.seqCounter = 0;
  }
}
