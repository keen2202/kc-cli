// Contract tests for the memory extraction guard (T1 / GR1–GR3).
//
// These assert the BEHAVIOUR CONTRACT of the deterministic safety layer that
// sits between a (non-deterministic) LLM extraction call and persistence:
//   CT1 legal output → parsed into a validated MemoryEntry
//   CT2 illegal output → discarded, never thrown
//   CT3 secret-bearing output → discarded (never persisted); protected paths redacted
//   CT4 size caps → per-entry byte truncation + max-entries-per-run cap
// Wording of any log message is intentionally NOT asserted.

import { describe, it, expect } from 'vitest';
import {
  parseAndValidate,
  parseAndValidateWithStats,
  redactSecrets,
  passesQualityCheck,
  PATH_PLACEHOLDER,
  MAX_CONTENT_BYTES,
  MIN_CONTENT_LENGTH,
} from '../../src/memory/memory-extraction-guard';

/** Build a single frontmatter block in the format buildExtractionPrompt emits. */
function block(name: string, description: string, type: string, content: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, `type: ${type}`, '---', content].join(
    '\n'
  );
}

const FIXED_NOW = 1_700_000_000_000;

describe('memory-extraction-guard', () => {
  // ── CT1: legal output is parsed into a validated entry ────────────────────
  describe('CT1 — legal output parses into a validated entry', () => {
    it('parses a well-formed block into exactly one entry', () => {
      const raw = block(
        'TypeScript Preference',
        'User prefers TypeScript strict mode',
        'user',
        'The user always prefers TypeScript strict mode for backend services.'
      );

      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });

      expect(entries).toHaveLength(1);
      expect(stats.totalBlocks).toBe(1);
      expect(stats.accepted).toBe(1);
      expect(stats.discardedInvalid).toBe(0);

      const [entry] = entries;
      expect(entry.header.name).toBe('TypeScript Preference');
      expect(entry.header.description).toBe('User prefers TypeScript strict mode');
      expect(entry.header.type).toBe('user');
      // Guard defaults validated LLM output to high confidence (T6/GR8).
      expect(entry.header.confidence).toBe('high');
      expect(entry.content).toContain('TypeScript strict mode');
    });

    it('derives deterministic timestamps and filenames from the injected clock', () => {
      const raw = block('My Note', 'a note', 'reference', 'This is a sufficiently long note body.');

      const a = parseAndValidate(raw, { now: FIXED_NOW });
      const b = parseAndValidate(raw, { now: FIXED_NOW });

      expect(a).toEqual(b);
      expect(a[0].header.createdAt).toBe(FIXED_NOW);
      expect(a[0].header.updatedAt).toBe(FIXED_NOW);
      expect(a[0].mtime).toBe(FIXED_NOW);
      expect(a[0].fileName).toBe(`my_note_${FIXED_NOW}_0.md`);
    });

    it('honours an explicit default confidence override', () => {
      const raw = block('Note', 'a note', 'user', 'This is a sufficiently long note body.');
      const [entry] = parseAndValidate(raw, { now: FIXED_NOW, defaultConfidence: 'low' });
      expect(entry.header.confidence).toBe('low');
    });
  });

  // ── CT2: illegal output is discarded (never thrown) ───────────────────────
  describe('CT2 — illegal output is discarded, never thrown', () => {
    it('discards a block with an unknown memory type', () => {
      const raw = block('Bad Type', 'desc', 'banana', 'This is a sufficiently long content body.');
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(0);
      expect(stats.discardedInvalid).toBe(1);
    });

    it('discards a block missing the required name field', () => {
      const raw = ['---', 'description: no name here', 'type: user', '---', 'A long enough content body.'].join(
        '\n'
      );
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(0);
      expect(stats.discardedInvalid).toBe(1);
    });

    it('discards a block with empty or too-short content (quality gate)', () => {
      const raw = block('Short', 'desc', 'user', 'too short');
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(0);
      expect(stats.discardedQuality).toBe(1);
    });

    it('never throws on completely malformed / empty input', () => {
      expect(() => parseAndValidate('not frontmatter at all')).not.toThrow();
      expect(parseAndValidate('')).toEqual([]);
      // @ts-expect-error — defensive: non-string input must not throw
      expect(parseAndValidate(null)).toEqual([]);
    });

    it('keeps valid blocks while discarding invalid ones in the same batch', () => {
      const good = block('Good', 'desc', 'user', 'This is a valid and sufficiently long body.');
      const bad = block('Bad', 'desc', 'nonsense', 'This is also long enough to pass quality.');
      const { entries, stats } = parseAndValidateWithStats(`${good}\n${bad}`, { now: FIXED_NOW });
      expect(entries).toHaveLength(1);
      expect(entries[0].header.name).toBe('Good');
      expect(stats.discardedInvalid).toBe(1);
    });
  });

  // ── CT3: secret interception (never persisted) + path redaction ───────────
  describe('CT3 — secrets are intercepted and never persisted', () => {
    it('discards an entry whose content contains a hard secret', () => {
      const raw = block(
        'Leaky',
        'desc',
        'user',
        'Use this key sk-abcdef0123456789ABCDEF to authenticate the client.'
      );
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(0);
      expect(stats.discardedSecret).toBe(1);
    });

    it('redactSecrets flags hard secrets so the caller can reject them', () => {
      const result = redactSecrets('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      expect(result.hadSecret).toBe(true);
    });

    it('redactSecrets replaces protected paths with a placeholder without flagging a secret', () => {
      const result = redactSecrets('The private key lives at /home/user/.ssh/id_rsa on disk.');
      expect(result.hadSecret).toBe(false);
      expect(result.redactedPath).toBe(true);
      expect(result.content).toContain(PATH_PLACEHOLDER);
      expect(result.content).not.toContain('.ssh/id_rsa');
    });

    it('keeps a path-bearing entry but redacts the path in persisted content', () => {
      const raw = block(
        'Path Note',
        'desc',
        'project',
        'Remember the deploy config path is /home/user/.ssh/id_rsa for this box.'
      );
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(1);
      expect(stats.redactedPaths).toBe(1);
      expect(entries[0].content).toContain(PATH_PLACEHOLDER);
      expect(entries[0].content).not.toContain('.ssh/id_rsa');
    });
  });

  // ── CT4: size caps (byte truncation + max entries per run) ────────────────
  describe('CT4 — size caps are enforced', () => {
    it('truncates per-entry content to the byte cap', () => {
      const huge = 'A'.repeat(MAX_CONTENT_BYTES * 2);
      const raw = block('Big', 'desc', 'user', huge);
      const { entries, stats } = parseAndValidateWithStats(raw, { now: FIXED_NOW });
      expect(entries).toHaveLength(1);
      expect(stats.truncated).toBe(1);
      expect(Buffer.byteLength(entries[0].content, 'utf-8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    });

    it('respects a custom maxContentBytes cap', () => {
      const raw = block('Big', 'desc', 'user', 'B'.repeat(500));
      const [entry] = parseAndValidate(raw, { now: FIXED_NOW, maxContentBytes: 64 });
      expect(Buffer.byteLength(entry.content, 'utf-8')).toBeLessThanOrEqual(64);
    });

    it('caps the number of entries returned per run', () => {
      const many = Array.from({ length: 5 }, (_, i) =>
        block(`Note ${i}`, 'desc', 'user', `This is note number ${i} with enough content length.`)
      ).join('\n');
      const entries = parseAndValidate(many, { now: FIXED_NOW, maxEntries: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  // ── Direct unit tests for the shared quality gate ─────────────────────────
  describe('passesQualityCheck', () => {
    it('rejects content shorter than the minimum length', () => {
      const res = passesQualityCheck('x'.repeat(MIN_CONTENT_LENGTH - 1));
      expect(res.pass).toBe(false);
      expect(res.reason).toBe('too_short');
    });

    it('rejects content that is mostly a code block', () => {
      const res = passesQualityCheck('```\n' + 'const x = 1;\n'.repeat(20) + '```');
      expect(res.pass).toBe(false);
      expect(res.reason).toBe('code_only');
    });

    it('accepts a normal prose sentence', () => {
      expect(passesQualityCheck('This is a perfectly normal sentence of prose.').pass).toBe(true);
    });
  });
});
