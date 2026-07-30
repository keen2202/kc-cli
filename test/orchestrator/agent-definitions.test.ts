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
    expect(def.defaultMaxTurns).toBe(30);
    expect(def.defaultTimeoutSeconds).toBe(300);
  });

  it('should define implementer agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.implementer;
    expect(def.name).toBe('implementer');
    expect(def.allowedTools).toContain('FileWrite');
    expect(def.allowedTools).toContain('FileEdit');
    expect(def.defaultMaxTurns).toBe(50);
    expect(def.defaultTimeoutSeconds).toBe(600);
  });

  it('should define verifier agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.verifier;
    expect(def.name).toBe('verifier');
    expect(def.allowedTools).toContain('Bash');
    expect(def.defaultMaxTurns).toBe(25);
  });

  it('should define explorer agent', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.explorer;
    expect(def.name).toBe('explorer');
    expect(def.allowedTools).toContain('FileRead');
    expect(def.defaultMaxTurns).toBe(20);
  });

  it('should define general agent with no tool restrictions', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.general;
    expect(def.name).toBe('general');
    expect(def.allowedTools).toBeUndefined();
  });

  it('should define frontend agent without backend-only tools', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.frontend;
    expect(def.name).toBe('frontend');
    expect(def.allowedTools).toContain('FileWrite');
    expect(def.allowedTools).toContain('LSP');
    expect(def.allowedTools).not.toContain('Sql');
    expect(def.deniedTools).toContain('Sql');
    expect(def.deniedTools).toContain('Docker');
    expect(def.defaultMaxTurns).toBe(50);
    expect(def.defaultTimeoutSeconds).toBe(600);
  });

  it('should define backend agent with database tools', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.backend;
    expect(def.name).toBe('backend');
    expect(def.allowedTools).toContain('Sql');
    expect(def.allowedTools).toContain('Docker');
    expect(def.allowedTools).toContain('FileEdit');
    expect(def.defaultMaxTurns).toBe(50);
    expect(def.defaultTimeoutSeconds).toBe(600);
  });

  it('should define fullstack agent with delegation tools', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.fullstack;
    expect(def.name).toBe('fullstack');
    expect(def.allowedTools).toContain('Sql');
    expect(def.allowedTools).toContain('WebSearch');
    expect(def.allowedTools).toContain('Agent');
    expect(def.allowedTools).toContain('TaskCreate');
    expect(def.defaultMaxTurns).toBe(60);
    expect(def.defaultTimeoutSeconds).toBe(900);
  });

  it('should define code-reviewer agent as read-only', () => {
    const def = BUILTIN_AGENT_DEFINITIONS['code-reviewer'];
    expect(def.name).toBe('code-reviewer');
    expect(def.allowedTools).not.toContain('FileWrite');
    expect(def.allowedTools).not.toContain('FileEdit');
    expect(def.allowedTools).toContain('LSP');
    expect(def.toolRestrictions).toEqual([
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ]);
  });

  it('should define tester agent with test execution tools', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.tester;
    expect(def.name).toBe('tester');
    expect(def.allowedTools).toContain('FileWrite');
    expect(def.allowedTools).toContain('Run');
    expect(def.allowedTools).toContain('Bash');
    expect(def.defaultMaxTurns).toBe(40);
  });

  it('should define architect agent with doc writing, delegation, and read-only Bash', () => {
    const def = BUILTIN_AGENT_DEFINITIONS.architect;
    expect(def.name).toBe('architect');
    expect(def.allowedTools).toContain('FileWrite');
    expect(def.allowedTools).toContain('Agent');
    expect(def.allowedTools).toContain('TeamCreate');
    expect(def.allowedTools).not.toContain('FileEdit');
    expect(def.toolRestrictions).toEqual([
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ]);
  });

  it('should define product-manager agent with planning and delegation tools', () => {
    const def = BUILTIN_AGENT_DEFINITIONS['product-manager'];
    expect(def.name).toBe('product-manager');
    expect(def.allowedTools).toContain('AskUser');
    expect(def.allowedTools).toContain('TodoWrite');
    expect(def.allowedTools).toContain('Agent');
    expect(def.allowedTools).not.toContain('FileEdit');
    expect(def.toolRestrictions).toEqual([
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ]);
  });

  it('should give every specialized agent a systemPrompt and description', () => {
    for (const type of ['frontend', 'backend', 'fullstack', 'code-reviewer', 'tester', 'architect', 'product-manager']) {
      const def = BUILTIN_AGENT_DEFINITIONS[type];
      expect(def.systemPrompt).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
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
    expect(types).toContain('frontend');
    expect(types).toContain('backend');
    expect(types).toContain('fullstack');
    expect(types).toContain('code-reviewer');
    expect(types).toContain('tester');
    expect(types).toContain('architect');
    expect(types).toContain('product-manager');
  });

  it('should return 12 agent types', () => {
    expect(listAgentTypes()).toHaveLength(12);
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

  it('should carry deniedTools from definition into spawn config', () => {
    const config = createAgentConfig('frontend', 'build a settings page');
    expect(config).not.toBeNull();
    expect(config!.deniedTools).toEqual(BUILTIN_AGENT_DEFINITIONS.frontend.deniedTools);
  });

  it('should create spawn configs for all specialized types', () => {
    for (const type of ['frontend', 'backend', 'fullstack', 'code-reviewer', 'tester', 'architect', 'product-manager']) {
      const config = createAgentConfig(type, 'task');
      expect(config).not.toBeNull();
      expect(config!.systemPrompt).toBeTruthy();
      expect(config!.tools).toEqual(BUILTIN_AGENT_DEFINITIONS[type].allowedTools);
    }
  });
});
