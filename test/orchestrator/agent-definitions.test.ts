import { describe, it, expect } from 'vitest';
import {
  BUILTIN_AGENT_DEFINITIONS,
  getAgentDefinition,
  listAgentTypes,
  createAgentConfig,
} from '../../src/orchestrator/agent-definitions';

describe('BUILTIN_AGENT_DEFINITIONS', () => {
  it('should define researcher agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.researcher;
    expect(def.name).toBe('researcher');
    expect(def.description).toContain('Read-only');
    expect(def.allowedTools).toContain('FileRead');
    expect(def.allowedTools).toContain('Grep');
    expect(def.defaultMaxTurns).toBe(20);
    expect(def.defaultTimeoutSeconds).toBe(300);
  });

  it('should define implementer agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.implementer;
    expect(def.name).toBe('implementer');
    expect(def.allowedTools).toContain('FileWrite');
    expect(def.allowedTools).toContain('FileEdit');
    expect(def.defaultMaxTurns).toBe(25);
    expect(def.defaultTimeoutSeconds).toBe(600);
  });

  it('should define verifier agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.verifier;
    expect(def.name).toBe('verifier');
    expect(def.allowedTools).toContain('Bash');
    expect(def.defaultMaxTurns).toBe(15);
  });

  it('should define explorer agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.explorer;
    expect(def.name).toBe('explorer');
    expect(def.allowedTools).toContain('FileRead');
    expect(def.defaultMaxTurns).toBe(15);
  });

  it('should define general agent with no tool restrictions', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.general;
    expect(def.name).toBe('general');
    expect(def.allowedTools).toBeUndefined();
  });
});

describe('getAgentDefinition', () => {
  it('should return definition for known type', () => {
    const def = getAgentDefinition('researcher');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('researcher');
  });

  it('should return null for unknown type', () => {
    expect(getAgentDefinition('nonexistent')).toBeNull();
  });

  it('should return all built-in types', () => {
    for (const type of listAgentTypes()) {
      expect(getAgentDefinition(type)).not.toBeNull();
    }
  });
});

describe('listAgentTypes', () => {
  it('should return all built-in agent type names', () => {
    const types = listAgentTypes();
    expect(types).toContain('researcher');
    expect(types).toContain('implementer');
    expect(types).toContain('verifier');
    expect(types).toContain('explorer');
    expect(types).toContain('general');
  });

  it('should return 5 agent types', () => {
    expect(listAgentTypes()).toHaveLength(5);
  });
});

describe('createAgentConfig', () => {
  it('should create config for known type', () => {
    const config = createAgentConfig('researcher', 'Find all TODOs');
    expect(config).not.toBeNull();
    expect(config!.prompt).toBe('Find all TODOs');
    expect(config!.systemPrompt).toContain('research assistant');
    expect(config!.maxTurns).toBe(30);
    expect(config!.timeoutSeconds).toBe(300);
    expect(config!.systemPromptMode).toBe('default');
  });

  it('should return null for unknown type', () => {
    expect(createAgentConfig('unknown', 'task')).toBeNull();
  });

  it('should apply overrides', () => {
    const config = createAgentConfig('researcher', 'task', {
      name: 'custom-name',
      maxTurns: 5,
      timeoutSeconds: 60,
      systemPromptMode: 'replace',
      model: 'gpt-4',
    });
    expect(config!.name).toBe('custom-name');
    expect(config!.maxTurns).toBe(5);
    expect(config!.timeoutSeconds).toBe(60);
    expect(config!.systemPromptMode).toBe('replace');
    expect(config!.model).toBe('gpt-4');
  });

  it('should generate default name when not overridden', () => {
    const config = createAgentConfig('researcher', 'task');
    expect(config!.name).toMatch(/^researcher-\d+$/);
  });

  it('should inherit tools from definition when not overridden', () => {
    const config = createAgentConfig('researcher', 'task');
    expect(config!.tools).toEqual(BUILTIN_AGENT_DEFINITIONS.researcher.allowedTools);
  });

  it('should allow tool overrides', () => {
    const config = createAgentConfig('researcher', 'task', {
      tools: ['FileRead' as any, 'Bash' as any],
    });
    expect(config!.tools).toEqual(['FileRead', 'Bash']);
  });
});
