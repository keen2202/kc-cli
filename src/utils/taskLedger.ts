export type LedgerStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface LedgerEntry {
  id: string;
  title: string;
  status: LedgerStatus;
  note?: string;
  updatedAt: number;
}

const LEGAL_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  pending: ['in_progress'],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: ['pending'],
};

export class TaskLedger {
  private readonly title: string;
  private readonly entries: LedgerEntry[] = [];
  private readonly byId = new Map<string, LedgerEntry>();

  constructor(title: string) {
    this.title = title;
  }

  add(entry: { id: string; title: string }): void {
    if (this.byId.has(entry.id)) {
      throw new Error(`DUPLICATE_ENTRY: ${entry.id}`);
    }
    const ledgerEntry: LedgerEntry = {
      id: entry.id,
      title: entry.title,
      status: 'pending',
      updatedAt: Date.now(),
    };
    this.entries.push(ledgerEntry);
    this.byId.set(entry.id, ledgerEntry);
  }

  transition(id: string, next: LedgerStatus): void {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`UNKNOWN_ENTRY: ${id}`);
    }
    if (!LEGAL_TRANSITIONS[entry.status].includes(next)) {
      throw new Error(`ILLEGAL_TRANSITION: ${entry.status} -> ${next}`);
    }
    entry.status = next;
    entry.updatedAt = Date.now();
  }

  get(id: string): LedgerEntry | undefined {
    return this.byId.get(id);
  }

  list(): readonly LedgerEntry[] {
    return this.entries;
  }

  listByStatus(status: LedgerStatus): LedgerEntry[] {
    return this.entries.filter((entry) => entry.status === status);
  }

  progress(): { total: number; completed: number; failed: number; ratio: number } {
    const total = this.entries.length;
    const completed = this.entries.filter((entry) => entry.status === 'completed').length;
    const failed = this.entries.filter((entry) => entry.status === 'failed').length;
    return { total, completed, failed, ratio: total === 0 ? 0 : completed / total };
  }

  toJSON(): string {
    return JSON.stringify({ title: this.title, entries: this.entries });
  }

  static fromJSON(json: string): TaskLedger {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('INVALID_LEDGER_JSON: failed to parse JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { title?: unknown }).title !== 'string' ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      throw new Error('INVALID_LEDGER_JSON: malformed ledger structure');
    }
    const data = parsed as { title: string; entries: unknown[] };
    const ledger = new TaskLedger(data.title);
    for (const raw of data.entries) {
      const entry = raw as Partial<LedgerEntry>;
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.id !== 'string' ||
        typeof entry.title !== 'string' ||
        typeof entry.updatedAt !== 'number' ||
        (entry.status !== 'pending' &&
          entry.status !== 'in_progress' &&
          entry.status !== 'completed' &&
          entry.status !== 'failed')
      ) {
        throw new Error('INVALID_LEDGER_JSON: malformed entry');
      }
      const restored: LedgerEntry = {
        id: entry.id,
        title: entry.title,
        status: entry.status,
        updatedAt: entry.updatedAt,
      };
      if (typeof entry.note === 'string') {
        restored.note = entry.note;
      }
      ledger.entries.push(restored);
      ledger.byId.set(restored.id, restored);
    }
    return ledger;
  }

  renderMarkdown(): string {
    const icons: Record<LedgerStatus, string> = {
      pending: '[ ]',
      in_progress: '[~]',
      completed: '[x]',
      failed: '[!]',
    };
    const lines = [`# ${this.title}`];
    for (const entry of this.entries) {
      lines.push(`- ${icons[entry.status]} ${entry.id}: ${entry.title}`);
    }
    return lines.join('\n') + '\n';
  }
}
