// Cache consistency layer
// Version tracking, invalidation propagation, and dependency graphs

export interface VersionedEntry {
  version: number;
  dependencies: Set<string>; // Keys this entry depends on
  dependents: Set<string>;   // Keys that depend on this entry
}

export class CacheConsistencyManager {
  private versions = new Map<string, number>();
  private dependencies = new Map<string, Set<string>>(); // key -> keys it depends on
  private dependents = new Map<string, Set<string>>();   // key -> keys that depend on it
  private globalVersion = 0;

  /**
   * Register a cache entry with its dependencies
   */
  register(key: string, dependencies: string[] = []): number {
    const version = ++this.globalVersion;
    this.versions.set(key, version);

    // Set up dependency graph
    const depSet = new Set(dependencies);
    this.dependencies.set(key, depSet);

    for (const dep of dependencies) {
      let dependents = this.dependents.get(dep);
      if (!dependents) {
        dependents = new Set();
        this.dependents.set(dep, dependents);
      }
      dependents.add(key);
    }

    return version;
  }

  /**
   * Get current version of a key
   */
  getVersion(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  /**
   * Check if a cached entry is still valid (version matches)
   */
  isValid(key: string, cachedVersion: number): boolean {
    return (this.versions.get(key) ?? 0) === cachedVersion;
  }

  /**
   * Invalidate a key and all its dependents (cascade invalidation)
   * Returns all invalidated keys
   */
  invalidate(key: string): Set<string> {
    const invalidated = new Set<string>();
    const queue = [key];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (invalidated.has(current)) continue;

      invalidated.add(current);
      this.versions.delete(current);

      // Remove from dependencies
      const deps = this.dependencies.get(current);
      if (deps) {
        for (const dep of deps) {
          this.dependents.get(dep)?.delete(current);
        }
        this.dependencies.delete(current);
      }

      // Cascade to dependents
      const dependents = this.dependents.get(current);
      if (dependents) {
        for (const dependent of dependents) {
          queue.push(dependent);
        }
        this.dependents.delete(current);
      }
    }

    return invalidated;
  }

  /**
   * Invalidate all entries matching a prefix
   */
  invalidateByPrefix(prefix: string): Set<string> {
    const invalidated = new Set<string>();
    for (const key of this.versions.keys()) {
      if (key.startsWith(prefix)) {
        const cascade = this.invalidate(key);
        for (const k of cascade) {
          invalidated.add(k);
        }
      }
    }
    return invalidated;
  }

  /**
   * Get all dependencies of a key (transitive)
   */
  getDependencies(key: string): Set<string> {
    const result = new Set<string>();
    const queue = [key];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const deps = this.dependencies.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!result.has(dep)) {
            result.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get all dependents of a key (transitive)
   */
  getDependents(key: string): Set<string> {
    const result = new Set<string>();
    const queue = [key];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const deps = this.dependents.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!result.has(dep)) {
            result.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    this.versions.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.globalVersion = 0;
  }

  /**
   * Get number of tracked entries
   */
  get size(): number {
    return this.versions.size;
  }

  /**
   * Update dependencies for an existing key
   */
  updateDependencies(key: string, newDependencies: string[]): number {
    // Remove old dependency references
    const oldDeps = this.dependencies.get(key);
    if (oldDeps) {
      for (const dep of oldDeps) {
        this.dependents.get(dep)?.delete(key);
      }
    }

    // Re-register with new dependencies
    return this.register(key, newDependencies);
  }
}

/**
 * Singleton instance
 */
let instance: CacheConsistencyManager | null = null;

export function getConsistencyManager(): CacheConsistencyManager {
  if (!instance) {
    instance = new CacheConsistencyManager();
  }
  return instance;
}
