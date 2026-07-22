import { describe, it, expect } from 'vitest';
import { tokenize, tokenSignature, containsCjk } from '../../src/utils/tokenize';

describe('tokenize', () => {
  describe('ASCII / Latin', () => {
    it('splits on whitespace and punctuation, lower-cases', () => {
      expect(tokenize('Fix the Login Bug!')).toEqual(['fix', 'login', 'bug']);
    });

    it('drops tokens shorter than 2 chars', () => {
      expect(tokenize('a b cd ef')).toEqual(['cd', 'ef']);
    });

    it('removes English stop words', () => {
      const tokens = tokenize('this is the config for you');
      expect(tokens).not.toContain('this');
      expect(tokens).not.toContain('the');
      expect(tokens).toContain('config');
    });

    it('de-duplicates tokens', () => {
      expect(tokenize('config config CONFIG')).toEqual(['config']);
    });

    it('returns empty array for empty input', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize('   ')).toEqual([]);
    });
  });

  describe('CJK', () => {
    it('produces bigrams and single chars', () => {
      const tokens = tokenize('查找文件');
      expect(tokens).toContain('查找');
      expect(tokens).toContain('文件');
      expect(tokens).toContain('查');
      expect(tokens).toContain('件');
    });

    it('handles a single CJK character', () => {
      expect(tokenize('码')).toEqual(['码']);
    });

    it('drops CJK stop words as single tokens but keeps bigrams', () => {
      // 的 is a stop word; single-char 的 removed, but bigrams retained
      const tokens = tokenize('我的代码');
      expect(tokens).not.toContain('的');
      expect(tokens).not.toContain('我');
      expect(tokens).toContain('代码');
    });
  });

  describe('mixed CJK + ASCII', () => {
    it('keeps ASCII words and CJK bigrams', () => {
      const tokens = tokenize('帮我查找 config 文件');
      expect(tokens).toContain('config');
      expect(tokens).toContain('查找');
      expect(tokens).toContain('文件');
    });
  });

  describe('tokenSignature', () => {
    it('is order-independent', () => {
      expect(tokenSignature('fix login bug')).toBe(tokenSignature('bug login fix'));
    });

    it('is case-independent', () => {
      expect(tokenSignature('Fix Login')).toBe(tokenSignature('fix login'));
    });

    it('differs for different token sets', () => {
      expect(tokenSignature('fix login')).not.toBe(tokenSignature('fix logout'));
    });
  });

  describe('containsCjk', () => {
    it('detects CJK characters', () => {
      expect(containsCjk('查找 config')).toBe(true);
      expect(containsCjk('find config')).toBe(false);
    });
  });
});
