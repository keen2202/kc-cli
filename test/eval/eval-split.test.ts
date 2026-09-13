// AGP T1 — held-in/held-out split 固定集校验与不相交保证
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVAL_SET_FORMAT,
  loadEvalSet,
  parseEvalSet,
  assertSplitsDisjoint,
} from '../../scripts/eval/metrics';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETS_DIR = path.resolve(HERE, '../../scripts/eval/sets');
const HELD_IN = path.join(SETS_DIR, 'longtask-held-in.json');
const HELD_OUT = path.join(SETS_DIR, 'longtask-held-out.json');

describe('eval split sets (kc.experiment_eval.v1)', () => {
  it('held-in set loads with required fields', () => {
    const set = loadEvalSet(HELD_IN);
    expect(set.format).toBe(EVAL_SET_FORMAT);
    expect(set.split).toBe('held-in');
    expect(set.tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of set.tasks) {
      expect(t.taskId).toBeTruthy();
      expect(t.repo).toBeTruthy();
      expect(t.commit).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.testCommand).toBeTruthy();
      expect(t.verificationCommand).toBeTruthy();
      expect(t.maxTurns).toBeGreaterThan(0);
      expect(t.maxBudgetUsd).toBeGreaterThan(0);
      expect(t.timeoutSec).toBeGreaterThan(0);
    }
  });

  it('held-out set loads with required fields', () => {
    const set = loadEvalSet(HELD_OUT);
    expect(set.format).toBe(EVAL_SET_FORMAT);
    expect(set.split).toBe('held-out');
    expect(set.tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of set.tasks) {
      expect(t.taskId).toBeTruthy();
      expect(t.verificationCommand).toBeTruthy();
    }
  });

  it('held-in and held-out taskIds are disjoint', () => {
    const heldIn = loadEvalSet(HELD_IN);
    const heldOut = loadEvalSet(HELD_OUT);
    expect(() => assertSplitsDisjoint(heldIn, heldOut)).not.toThrow();
    const inIds = new Set(heldIn.tasks.map((t) => t.taskId));
    for (const t of heldOut.tasks) {
      expect(inIds.has(t.taskId)).toBe(false);
    }
  });

  it('rejects wrong format', () => {
    expect(() => parseEvalSet(JSON.stringify({ format: 'other', split: 'held-in', tasks: [{ taskId: 'x' }] }))).toThrow(
      /invalid|format/i,
    );
  });

  it('rejects empty tasks', () => {
    expect(() =>
      parseEvalSet(JSON.stringify({ format: EVAL_SET_FORMAT, split: 'held-in', tasks: [] })),
    ).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() =>
      parseEvalSet(
        JSON.stringify({
          format: EVAL_SET_FORMAT,
          split: 'held-in',
          tasks: [
            {
              taskId: 't1',
              repo: 'r',
              commit: 'c',
              prompt: 'p',
              testCommand: 'x',
              // verificationCommand missing
              maxTurns: 1,
              maxBudgetUsd: 0.1,
              timeoutSec: 10,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('rejects duplicate taskIds inside one set', () => {
    const task = {
      taskId: 'dup',
      repo: 'local:x',
      commit: 'c',
      prompt: 'p',
      testCommand: 'x',
      verificationCommand: 'x',
      maxTurns: 1,
      maxBudgetUsd: 0.1,
      timeoutSec: 10,
    };
    expect(() =>
      parseEvalSet(JSON.stringify({ format: EVAL_SET_FORMAT, split: 'held-in', tasks: [task, task] })),
    ).toThrow(/duplicate/);
  });

  it('assertSplitsDisjoint throws on overlap', () => {
    const mk = (split: 'held-in' | 'held-out') => ({
      format: EVAL_SET_FORMAT,
      split,
      tasks: [
        {
          taskId: 'shared-id',
          repo: 'local:a',
          commit: 'c',
          prompt: 'p',
          testCommand: 'x',
          verificationCommand: 'x',
          maxTurns: 1,
          maxBudgetUsd: 0.1,
          timeoutSec: 10,
        },
      ],
    });
    const a = parseEvalSet(JSON.stringify(mk('held-in')));
    const b = parseEvalSet(JSON.stringify(mk('held-out')));
    expect(() => assertSplitsDisjoint(a, b)).toThrow(/shared-id/);
  });
});
