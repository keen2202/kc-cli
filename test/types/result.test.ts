import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  mapResult,
  flatMap,
  unwrapOr,
} from '../../src/utils/result';
import type { Result } from '../../src/utils/result';

describe('Result<T, E>', () => {
  describe('ok() and err()', () => {
    it('creates an Ok result with the given value', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it('creates an Err result with the given error', () => {
      const result = err('something broke');
      expect(result.ok).toBe(false);
      expect(result).toEqual({ ok: false, error: 'something broke' });
    });

    it('wraps complex objects in Ok', () => {
      const data = { name: 'test', count: 3 };
      const result = ok(data);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(data);
      }
    });

    it('wraps Error instances in Err', () => {
      const error = new Error('boom');
      const result = err(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(error);
        expect(result.error.message).toBe('boom');
      }
    });
  });

  describe('isOk() type guard', () => {
    it('returns true for Ok results', () => {
      const result = ok('hello');
      expect(isOk(result)).toBe(true);
    });

    it('returns false for Err results', () => {
      const result = err('fail');
      expect(isOk(result)).toBe(false);
    });

    it('narrows the type to Ok when true', () => {
      const result: Result<number, string> = ok(10);
      if (isOk(result)) {
        // TypeScript narrows: result.value is number
        expect(result.value).toBe(10);
      }
    });
  });

  describe('isErr() type guard', () => {
    it('returns true for Err results', () => {
      const result = err('fail');
      expect(isErr(result)).toBe(true);
    });

    it('returns false for Ok results', () => {
      const result = ok('hello');
      expect(isErr(result)).toBe(false);
    });

    it('narrows the type to Err when true', () => {
      const result: Result<number, string> = err('oops');
      if (isErr(result)) {
        // TypeScript narrows: result.error is string
        expect(result.error).toBe('oops');
      }
    });
  });

  describe('mapResult()', () => {
    it('transforms the Ok value', () => {
      const result = ok(5);
      const mapped = mapResult(result, (n) => n * 2);
      expect(mapped).toEqual({ ok: true, value: 10 });
    });

    it('passes Err through unchanged', () => {
      const result = err('bad');
      const mapped = mapResult(result, (n: number) => n * 2);
      expect(mapped).toEqual({ ok: false, error: 'bad' });
    });

    it('allows changing the value type', () => {
      const result = ok(42);
      const mapped = mapResult(result, (n) => n.toString());
      expect(isOk(mapped) && mapped.value).toBe('42');
    });
  });

  describe('flatMap()', () => {
    it('chains Ok results through the function', () => {
      const result = ok(5);
      const chained = flatMap(result, (n) => ok(n + 1));
      expect(chained).toEqual({ ok: true, value: 6 });
    });

    it('returns Err when the function returns Err', () => {
      const result = ok(5);
      const chained = flatMap(result, (_n) => err('conversion failed'));
      expect(chained).toEqual({ ok: false, error: 'conversion failed' });
    });

    it('passes Err through unchanged (short-circuits)', () => {
      const result = err('original error');
      const chained = flatMap(result, (n: number) => ok(n + 1));
      expect(chained).toEqual({ ok: false, error: 'original error' });
    });

    it('supports multi-step chaining', () => {
      const parse = (s: string): Result<number, string> => {
        const n = parseInt(s, 10);
        return isNaN(n) ? err('not a number') : ok(n);
      };
      const double = (n: number): Result<number, string> =>
        n > 100 ? err('too big') : ok(n * 2);

      const chained = flatMap(flatMap(ok('21'), parse), double);
      expect(chained).toEqual({ ok: true, value: 42 });
    });
  });

  describe('unwrapOr()', () => {
    it('returns the Ok value when present', () => {
      const result = ok(42);
      expect(unwrapOr(result, 0)).toBe(42);
    });

    it('returns the default value when Err', () => {
      const result: Result<number, string> = err('nope');
      expect(unwrapOr(result, 99)).toBe(99);
    });

    it('works with string defaults', () => {
      const okResult = ok('actual');
      expect(unwrapOr(okResult, 'fallback')).toBe('actual');

      const errResult: Result<string, string> = err('oops');
      expect(unwrapOr(errResult, 'fallback')).toBe('fallback');
    });

    it('works with null/undefined defaults', () => {
      const result: Result<string, Error> = err(new Error('fail'));
      expect(unwrapOr(result, null)).toBeNull();
      expect(unwrapOr(result, undefined)).toBeUndefined();
    });
  });

  describe('immutability', () => {
    it('Ok result properties are readonly', () => {
      const result = ok(10) as Readonly<Ok<number>>;
      expect(result.ok).toBe(true);
      expect(result.value).toBe(10);
    });

    it('Err result properties are readonly', () => {
      const result = err('fail') as Readonly<Err<string>>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('fail');
    });
  });
});
