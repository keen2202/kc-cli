import { describe, expect, it } from 'vitest';

import { TaskLedger } from '../../src/utils/taskLedger.js';

describe('TaskLedger.add', () => {
  it('adds entries with pending status and an updatedAt timestamp', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    const entry = ledger.get('a');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('pending');
    expect(typeof entry?.updatedAt).toBe('number');
  });

  it('throws DUPLICATE_ENTRY when adding an existing id', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    expect(() => ledger.add({ id: 'a', title: 'Other' })).toThrowError(/DUPLICATE_ENTRY/);
  });
});

describe('TaskLedger.transition', () => {
  it('throws UNKNOWN_ENTRY for a missing id', () => {
    const ledger = new TaskLedger('Demo');
    expect(() => ledger.transition('nope', 'in_progress')).toThrowError(/UNKNOWN_ENTRY/);
  });

  it('allows pending -> in_progress', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    expect(ledger.get('a')?.status).toBe('in_progress');
  });

  it('allows in_progress -> completed', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'completed');
    expect(ledger.get('a')?.status).toBe('completed');
  });

  it('allows in_progress -> failed', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'failed');
    expect(ledger.get('a')?.status).toBe('failed');
  });

  it('allows failed -> pending', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'failed');
    ledger.transition('a', 'pending');
    expect(ledger.get('a')?.status).toBe('pending');
  });

  it('rejects transitioning a completed entry (terminal state)', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'completed');
    expect(() => ledger.transition('a', 'pending')).toThrowError(/ILLEGAL_TRANSITION/);
    expect(() => ledger.transition('a', 'in_progress')).toThrowError(/ILLEGAL_TRANSITION/);
  });

  it('rejects pending -> completed (skipping in_progress)', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    expect(() => ledger.transition('a', 'completed')).toThrowError(/ILLEGAL_TRANSITION/);
  });

  it('rejects failed -> completed', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'failed');
    expect(() => ledger.transition('a', 'completed')).toThrowError(/ILLEGAL_TRANSITION/);
  });

  it('refreshes updatedAt on a successful transition', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'Task A' });
    const before = ledger.get('a')!.updatedAt;
    ledger.transition('a', 'in_progress');
    expect(ledger.get('a')!.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('TaskLedger queries', () => {
  it('get returns undefined for unknown ids', () => {
    const ledger = new TaskLedger('Demo');
    expect(ledger.get('missing')).toBeUndefined();
  });

  it('list preserves insertion order', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'b', title: 'B' });
    ledger.add({ id: 'a', title: 'A' });
    ledger.add({ id: 'c', title: 'C' });
    expect(ledger.list().map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
  });

  it('listByStatus filters by status', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'A' });
    ledger.add({ id: 'b', title: 'B' });
    ledger.add({ id: 'c', title: 'C' });
    ledger.transition('a', 'in_progress');
    ledger.transition('b', 'in_progress');
    ledger.transition('b', 'completed');
    expect(ledger.listByStatus('pending').map((entry) => entry.id)).toEqual(['c']);
    expect(ledger.listByStatus('in_progress').map((entry) => entry.id)).toEqual(['a']);
    expect(ledger.listByStatus('completed').map((entry) => entry.id)).toEqual(['b']);
    expect(ledger.listByStatus('failed')).toEqual([]);
  });
});

describe('TaskLedger.progress', () => {
  it('returns ratio 0 for an empty ledger', () => {
    const ledger = new TaskLedger('Demo');
    expect(ledger.progress()).toEqual({ total: 0, completed: 0, failed: 0, ratio: 0 });
  });

  it('computes totals and ratio without rounding', () => {
    const ledger = new TaskLedger('Demo');
    ledger.add({ id: 'a', title: 'A' });
    ledger.add({ id: 'b', title: 'B' });
    ledger.add({ id: 'c', title: 'C' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'completed');
    ledger.transition('b', 'in_progress');
    ledger.transition('b', 'failed');
    expect(ledger.progress()).toEqual({ total: 3, completed: 1, failed: 1, ratio: 1 / 3 });
  });
});

describe('TaskLedger JSON round-trip', () => {
  it('toJSON/fromJSON restores title and all entries', () => {
    const ledger = new TaskLedger('Release');
    ledger.add({ id: 'a', title: 'A' });
    ledger.add({ id: 'b', title: 'B' });
    ledger.transition('a', 'in_progress');
    ledger.transition('a', 'completed');

    const restored = TaskLedger.fromJSON(ledger.toJSON());
    expect(restored.toJSON()).toBe(ledger.toJSON());
    expect(restored.list()).toEqual(ledger.list());
    expect(restored.get('a')?.status).toBe('completed');
    expect(restored.get('a')?.updatedAt).toBe(ledger.get('a')?.updatedAt);
    expect(restored.renderMarkdown()).toBe(ledger.renderMarkdown());
  });

  it('fromJSON throws INVALID_LEDGER_JSON for malformed JSON text', () => {
    expect(() => TaskLedger.fromJSON('{not json')).toThrowError(/INVALID_LEDGER_JSON/);
  });

  it('fromJSON throws INVALID_LEDGER_JSON for structurally invalid payloads', () => {
    expect(() => TaskLedger.fromJSON('{"title":"x"}')).toThrowError(/INVALID_LEDGER_JSON/);
    expect(() => TaskLedger.fromJSON('{"entries":[]}')).toThrowError(/INVALID_LEDGER_JSON/);
    expect(() => TaskLedger.fromJSON('[1,2,3]')).toThrowError(/INVALID_LEDGER_JSON/);
    expect(() =>
      TaskLedger.fromJSON('{"title":"x","entries":[{"id":"a","title":"A","status":"bogus","updatedAt":1}]}'),
    ).toThrowError(/INVALID_LEDGER_JSON/);
  });
});

describe('TaskLedger.renderMarkdown', () => {
  it('renders a deterministic markdown document for a fixed fixture', () => {
    const ledger = new TaskLedger('Sprint Plan');
    ledger.add({ id: 't1', title: 'Design' });
    ledger.add({ id: 't2', title: 'Build' });
    ledger.add({ id: 't3', title: 'Ship' });
    ledger.add({ id: 't4', title: 'Fix' });
    ledger.transition('t2', 'in_progress');
    ledger.transition('t3', 'in_progress');
    ledger.transition('t3', 'completed');
    ledger.transition('t4', 'in_progress');
    ledger.transition('t4', 'failed');

    expect(ledger.renderMarkdown()).toBe(
      '# Sprint Plan\n' +
        '- [ ] t1: Design\n' +
        '- [~] t2: Build\n' +
        '- [x] t3: Ship\n' +
        '- [!] t4: Fix\n',
    );
  });

  it('renders only the title line for an empty ledger', () => {
    const ledger = new TaskLedger('Empty');
    expect(ledger.renderMarkdown()).toBe('# Empty\n');
  });
});
