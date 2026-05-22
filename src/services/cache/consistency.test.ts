// Tests for CacheConsistencyManager

import { describe, it, expect, beforeEach } from 'vitest';
import { CacheConsistencyManager } from './consistency';

describe('CacheConsistencyManager', () => {
  let manager: CacheConsistencyManager;

  beforeEach(() => {
    manager = new CacheConsistencyManager();
  });

  describe('register', () => {
    it('should register a key and return version', () => {
      const version = manager.register('key1');
      expect(version).toBe(1);
    });

    it('should increment version on each registration', () => {
      const v1 = manager.register('key1');
      const v2 = manager.register('key2');
      expect(v2).toBe(v1 + 1);
    });

    it('should register with dependencies', () => {
      manager.register('dep1');
      manager.register('dep2');
      const version = manager.register('key1', ['dep1', 'dep2']);
      expect(version).toBe(3);
    });
  });

  describe('getVersion', () => {
    it('should return version for registered key', () => {
      manager.register('key1');
      expect(manager.getVersion('key1')).toBe(1);
    });

    it('should return 0 for unregistered key', () => {
      expect(manager.getVersion('unknown')).toBe(0);
    });
  });

  describe('isValid', () => {
    it('should return true for matching version', () => {
      const version = manager.register('key1');
      expect(manager.isValid('key1', version)).toBe(true);
    });

    it('should return false for mismatched version', () => {
      manager.register('key1');
      manager.register('key1'); // New version
      expect(manager.isValid('key1', 1)).toBe(false);
    });

    it('should return false for unregistered key', () => {
      expect(manager.isValid('unknown', 1)).toBe(false);
    });
  });

  describe('invalidate', () => {
    it('should invalidate a key', () => {
      manager.register('key1');
      const invalidated = manager.invalidate('key1');
      expect(invalidated.has('key1')).toBe(true);
      expect(manager.getVersion('key1')).toBe(0);
    });

    it('should cascade invalidation to dependents', () => {
      manager.register('dep1');
      manager.register('key1', ['dep1']);
      manager.register('key2', ['key1']);

      const invalidated = manager.invalidate('dep1');
      expect(invalidated.has('dep1')).toBe(true);
      expect(invalidated.has('key1')).toBe(true);
      expect(invalidated.has('key2')).toBe(true);
    });

    it('should not invalidate unrelated keys', () => {
      manager.register('key1');
      manager.register('key2');

      const invalidated = manager.invalidate('key1');
      expect(invalidated.has('key1')).toBe(true);
      expect(invalidated.has('key2')).toBe(false);
    });

    it('should handle circular dependencies', () => {
      manager.register('key1', ['key2']);
      manager.register('key2', ['key1']);

      const invalidated = manager.invalidate('key1');
      expect(invalidated.has('key1')).toBe(true);
      expect(invalidated.has('key2')).toBe(true);
    });
  });

  describe('invalidateByPrefix', () => {
    it('should invalidate all keys matching prefix', () => {
      manager.register('prefix:key1');
      manager.register('prefix:key2');
      manager.register('other:key3');

      const invalidated = manager.invalidateByPrefix('prefix:');
      expect(invalidated.has('prefix:key1')).toBe(true);
      expect(invalidated.has('prefix:key2')).toBe(true);
      expect(invalidated.has('other:key3')).toBe(false);
    });
  });

  describe('getDependencies', () => {
    it('should return direct dependencies', () => {
      manager.register('dep1');
      manager.register('dep2');
      manager.register('key1', ['dep1', 'dep2']);

      const deps = manager.getDependencies('key1');
      expect(deps.has('dep1')).toBe(true);
      expect(deps.has('dep2')).toBe(true);
    });

    it('should return transitive dependencies', () => {
      manager.register('dep1');
      manager.register('key1', ['dep1']);
      manager.register('key2', ['key1']);

      const deps = manager.getDependencies('key2');
      expect(deps.has('dep1')).toBe(true);
      expect(deps.has('key1')).toBe(true);
    });

    it('should return empty set for key with no dependencies', () => {
      manager.register('key1');
      expect(manager.getDependencies('key1').size).toBe(0);
    });
  });

  describe('getDependents', () => {
    it('should return direct dependents', () => {
      manager.register('dep1');
      manager.register('key1', ['dep1']);
      manager.register('key2', ['dep1']);

      const dependents = manager.getDependents('dep1');
      expect(dependents.has('key1')).toBe(true);
      expect(dependents.has('key2')).toBe(true);
    });

    it('should return transitive dependents', () => {
      manager.register('dep1');
      manager.register('key1', ['dep1']);
      manager.register('key2', ['key1']);

      const dependents = manager.getDependents('dep1');
      expect(dependents.has('key1')).toBe(true);
      expect(dependents.has('key2')).toBe(true);
    });

    it('should return empty set for key with no dependents', () => {
      manager.register('key1');
      expect(manager.getDependents('key1').size).toBe(0);
    });
  });

  describe('updateDependencies', () => {
    it('should update dependencies for existing key', () => {
      manager.register('dep1');
      manager.register('dep2');
      manager.register('key1', ['dep1']);

      manager.updateDependencies('key1', ['dep2']);

      const deps = manager.getDependencies('key1');
      expect(deps.has('dep1')).toBe(false);
      expect(deps.has('dep2')).toBe(true);
    });

    it('should return new version', () => {
      manager.register('key1');
      const newVersion = manager.updateDependencies('key1', []);
      expect(newVersion).toBeGreaterThan(1);
    });
  });

  describe('clear', () => {
    it('should clear all tracking data', () => {
      manager.register('key1', ['dep1']);
      manager.register('key2');

      manager.clear();
      expect(manager.size).toBe(0);
      expect(manager.getVersion('key1')).toBe(0);
    });
  });

  describe('size', () => {
    it('should return number of tracked entries', () => {
      expect(manager.size).toBe(0);
      manager.register('key1');
      expect(manager.size).toBe(1);
      manager.register('key2');
      expect(manager.size).toBe(2);
    });
  });
});
