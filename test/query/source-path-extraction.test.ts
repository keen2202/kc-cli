import { describe, it, expect } from 'vitest';
import { buildSourcePathRegex, TRACKED_SOURCE_EXTENSIONS } from '../../src/constants';
import { PlanningPhaseHandler } from '../../src/query/QueryEnginePlanning';
import type { AssistantMessage } from '../../src/query/protocol';

function assistant(content: string): AssistantMessage {
  return { role: 'assistant', content } as AssistantMessage;
}

describe('buildSourcePathRegex — language-agnostic file paths (H2)', () => {
  it('matches common and less-common language extensions', () => {
    const text = [
      'src/app/Main.cs',
      'lib/util.kt',
      'db/schema.sql',
      'server/main.go',
      'core/lib.rs',
      'ui/App.vue',
      'ui/Widget.svelte',
      'config/app.yaml',
      'config/app.toml',
      'scripts/build.sh',
      'src/index.ts',
    ].join(' and ');

    const matches = text.match(buildSourcePathRegex()) || [];
    expect(matches).toContain('src/app/Main.cs');
    expect(matches).toContain('lib/util.kt');
    expect(matches).toContain('db/schema.sql');
    expect(matches).toContain('ui/App.vue');
    expect(matches).toContain('ui/Widget.svelte');
    expect(matches).toContain('config/app.yaml');
    expect(matches).toContain('config/app.toml');
    expect(matches).toContain('scripts/build.sh');
    expect(matches).toContain('src/index.ts');
  });

  it('matches Windows backslash-separated paths', () => {
    const text = 'edit C:\\project\\src\\Program.cs to fix it';
    const matches = text.match(buildSourcePathRegex()) || [];
    expect(matches.some((m) => m.endsWith('Program.cs'))).toBe(true);
  });

  it('exposes a broad, de-duplicated extension set', () => {
    expect(TRACKED_SOURCE_EXTENSIONS).toContain('cs');
    expect(TRACKED_SOURCE_EXTENSIONS).toContain('kt');
    expect(TRACKED_SOURCE_EXTENSIONS).toContain('sql');
    expect(new Set(TRACKED_SOURCE_EXTENSIONS).size).toBe(TRACKED_SOURCE_EXTENSIONS.length);
  });
});

describe('PlanningPhaseHandler.extractFindings — uses shared extension set', () => {
  it('captures .cs/.kt/.sql files referenced in a hypothesis', () => {
    const handler = new PlanningPhaseHandler();
    const findings = handler.extractFindings([
      assistant('root cause: null deref in src/Service.cs and db/queries.sql via lib/Helper.kt'),
    ]);

    expect(findings.length).toBe(1);
    const files = findings[0].relevantFiles;
    expect(files).toContain('src/Service.cs');
    expect(files).toContain('db/queries.sql');
    expect(files).toContain('lib/Helper.kt');
  });
});
