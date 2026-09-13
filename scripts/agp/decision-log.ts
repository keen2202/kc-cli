/**
 * Append-only decision log for the offline AGP lab.
 * Layout: <labRoot>/decisions/decisions.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { type LabPaths } from './lab-paths';

export type DecisionAction = 'promote' | 'rollback' | 'reject' | 'archive';

export interface DecisionRecord {
  action: DecisionAction;
  artifactId: string;
  variantId: string;
  /** Previous active variant id, if any. */
  previousActive: string | null;
  /** New active variant id, or null when falling back to baseline. */
  newActive: string | null;
  evidenceRef: string | null;
  operator: string;
  reason: string;
  timestamp: number;
}

export class DecisionLog {
  private readonly filePath: string;

  constructor(paths: LabPaths) {
    this.filePath = path.join(paths.root, 'decisions', 'decisions.jsonl');
  }

  append(record: DecisionRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
  }

  list(): DecisionRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n');
    const out: DecisionRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as DecisionRecord);
      } catch {
        /* skip corrupt line — append-only log stays readable */
      }
    }
    return out;
  }

  listForArtifact(artifactId: string): DecisionRecord[] {
    return this.list().filter(r => r.artifactId === artifactId);
  }
}
