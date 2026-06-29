import { describe, it, expect } from 'vitest';
import { ImportanceTagger } from './QueryEngineImportance';
import type { AssistantMessage } from './protocol';

function makeMsg(content: string): AssistantMessage {
  return {
    id: 'test-id',
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

describe('ImportanceTagger', () => {
  const tagger = new ImportanceTagger();

  it('tags test failures as key_finding', () => {
    const msg = makeMsg('The test failed');
    const tag = tagger.tagTurn(msg, ['bash'], ['AssertionError: expected 1 got 2'], 1, []);
    expect(tag.importance).toBe('key_finding');
  });

  it('tags ERROR as key_finding', () => {
    const msg = makeMsg('Found the bug');
    const tag = tagger.tagTurn(msg, ['bash'], ['ERROR: module not found in src/foo.py'], 1, []);
    expect(tag.importance).toBe('key_finding');
  });

  it('tags revert acknowledgments as failed_attempt', () => {
    const msg = makeMsg("That didn't work. Let me revert and try a different approach.");
    const tag = tagger.tagTurn(msg, ['bash'], ['some output'], 1, []);
    expect(tag.importance).toBe('failed_attempt');
  });

  it('tags write+wrong as failed_attempt', () => {
    const msg = makeMsg("That didn't work.");
    const tag = tagger.tagTurn(msg, ['write'], ['some output'], 1, []);
    expect(tag.importance).toBe('failed_attempt');
  });

  it('tags normal read as exploration', () => {
    const msg = makeMsg('Let me read the file');
    const tag = tagger.tagTurn(msg, ['read'], ['class Foo:\n  pass'], 1, []);
    expect(tag.importance).toBe('exploration');
  });

  it('detects duplicate reads within window', () => {
    const readHistory = new Map([['/foo.ts', 1]]);
    const editHistory = new Map<string, number>();
    expect(tagger.isDuplicateRead('/foo.ts', 3, readHistory, editHistory, 3)).toBe(true);
  });

  it('does not flag as duplicate when file was edited since last read', () => {
    const readHistory = new Map([['/foo.ts', 1]]);
    const editHistory = new Map([['/foo.ts', 2]]);
    expect(tagger.isDuplicateRead('/foo.ts', 3, readHistory, editHistory, 3)).toBe(false);
  });
});
