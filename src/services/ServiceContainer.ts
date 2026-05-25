// Dependency Injection container
// Replaces global singletons with managed service lifecycle.
// Existing global accessors (getState, getCacheManager, etc.) delegate
// to the container for backward compatibility.

export type ServiceLifecycle = 'singleton' | 'transient';

interface ServiceEntry<T> {
  factory: () => T;
  lifecycle: ServiceLifecycle;
  instance?: T;
}

export class ServiceContainer {
  private services = new Map<string, ServiceEntry<any>>();

  /**
   * Register a service factory.
   */
  register<T>(
    name: string,
    factory: () => T,
    lifecycle: ServiceLifecycle = 'singleton'
  ): void {
    this.services.set(name, { factory, lifecycle });
  }

  /**
   * Resolve a service by name.
   */
  resolve<T>(name: string): T {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`Service not registered: ${name}`);
    }

    if (entry.lifecycle === 'singleton') {
      if (!entry.instance) {
        entry.instance = entry.factory();
      }
      return entry.instance as T;
    }

    return entry.factory() as T;
  }

  /**
   * Check if a service is registered.
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Remove all registered services.
   */
  clear(): void {
    this.services.clear();
  }
}

/** Global container instance */
let _container: ServiceContainer | null = null;

export function getServiceContainer(): ServiceContainer {
  if (!_container) {
    _container = new ServiceContainer();
  }
  return _container;
}

/** Replace the global container (for testing) */
export function setServiceContainer(container: ServiceContainer): void {
  _container = container;
}
