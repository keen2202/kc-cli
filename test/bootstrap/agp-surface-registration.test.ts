// AGP instruction-surface registration bridge tests (harness-evolution T1).
//
// Bootstrap Phase 3d registers every evolvable instruction surface as an AGP
// Prompt resource so the registry can list/evolve them. These tests pin the
// production loop: all evolvable surfaces land in the registry, registration
// is idempotent, and records already present (e.g. restored from disk by
// loadState) are left untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getGlobalRegistry,
  resetGlobalRegistry,
  type GlobalRegistry,
} from '../../src/agp/registry';
import { DEFAULT_EVOLUTION_CONFIG } from '../../src/agp/protocol';
import { createSurfacePromptRecords } from '../../src/api/prompts/instruction-surfaces';

/** Mirror of the Bootstrap Phase 3d registration loop. */
function registerSurfaces(registry: GlobalRegistry): void {
  for (const record of createSurfacePromptRecords()) {
    if (!registry.get('Prompt', record.entity.name)) {
      registry.register('Prompt', record);
    }
  }
}

let registry: GlobalRegistry;

beforeEach(() => {
  resetGlobalRegistry();
  // No disk persistence and no trace session in tests.
  registry = getGlobalRegistry({
    evolution: { ...DEFAULT_EVOLUTION_CONFIG, persistState: false },
    tracingEnabled: false,
  });
});

afterEach(() => {
  resetGlobalRegistry();
});

describe('AGP registry — evolvable instruction surfaces (T1)', () => {
  it('registers every evolvable surface as a listable Prompt resource', () => {
    const records = createSurfacePromptRecords();
    expect(records.length).toBeGreaterThan(0);

    registerSurfaces(registry);

    const promptNames = registry
      .listAll()
      .filter((r) => r.type === 'Prompt')
      .map((r) => r.name);
    for (const record of records) {
      expect(promptNames).toContain(record.entity.name);
      expect(record.entity.name).toMatch(/^instruction-surface-/);
      // Retrievable individually, marked evolvable.
      const stored = registry.get('Prompt', record.entity.name);
      expect(stored).not.toBeNull();
      expect(stored!.entity.evolvability).toBe(1);
    }
  });

  it('is idempotent: a second registration pass changes nothing', () => {
    registerSurfaces(registry);
    const countAfterFirst = registry.listAll().length;

    expect(() => registerSurfaces(registry)).not.toThrow();
    expect(registry.listAll().length).toBe(countAfterFirst);
  });

  it('leaves a pre-existing record untouched (disk-restore compatibility)', () => {
    const [first] = createSurfacePromptRecords();
    // Simulate a record already restored from disk with an evolved payload.
    const restored = {
      ...first,
      entity: { ...first.entity, description: 'evolved on disk' },
    };
    registry.register('Prompt', restored);

    registerSurfaces(registry);

    const stored = registry.get('Prompt', first.entity.name);
    expect(stored!.entity.description).toBe('evolved on disk');
  });
});
