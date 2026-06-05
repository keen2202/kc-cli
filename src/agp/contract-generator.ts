/**
 * AGP Contract Generator
 *
 * Automatically generates capability contracts for registered resources.
 * Contracts describe what a resource can do, its inputs/outputs, and
 * its constraints — reducing prompt bloat by providing structured
 * capability descriptions instead of full documentation.
 *
 * Corresponds to the paper's "contract generation" mechanism (§5.2).
 */

import type { ServerInterface } from './server-interface';
import type {
  ResourceType,
  ResourceRegistrationRecord,
  ResourceInfo,
  ExportedRepresentation,
} from './protocol';
import { RESOURCE_TYPES } from './protocol';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResourceContract {
  /** Resource qualified name */
  resourceName: string;
  /** Resource type */
  resourceType: ResourceType;
  /** Contract version (matches resource version) */
  version: string;
  /** Capability summary */
  capabilities: string[];
  /** Input specification */
  inputs: ContractIOSpec;
  /** Output specification */
  outputs: ContractIOSpec;
  /** Constraints and limitations */
  constraints: string[];
  /** Whether the resource is evolvable */
  evolvable: boolean;
  /** Contract generation timestamp */
  generatedAt: number;
}

export interface ContractIOSpec {
  /** Schema type */
  schemaType: 'json-schema' | 'text' | 'unknown';
  /** Schema content */
  schema: unknown;
  /** Human-readable description */
  description: string;
}

export interface ContractBundle {
  /** All contracts in the bundle */
  contracts: ResourceContract[];
  /** Generation metadata */
  metadata: {
    generatedAt: number;
    totalContracts: number;
    typesCovered: ResourceType[];
  };
  /** Compact text representation for prompt injection */
  compactText: string;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class ContractGenerator {
  private serverInterface: ServerInterface;

  constructor(serverInterface: ServerInterface) {
    this.serverInterface = serverInterface;
  }

  /**
   * Generate contracts for all registered resources.
   */
  generateAll(): ContractBundle {
    const contracts: ResourceContract[] = [];
    const typesCovered = new Set<ResourceType>();

    for (const type of RESOURCE_TYPES) {
      try {
        const names = this.serverInterface.list(type);
        for (const name of names) {
          try {
            const contract = this.generateForResource(type, name);
            if (contract) {
              contracts.push(contract);
              typesCovered.add(type);
            }
          } catch {
            // Skip resources that can't generate contracts
          }
        }
      } catch {
        // Skip inaccessible types
      }
    }

    const compactText = this.generateCompactText(contracts);

    return {
      contracts,
      metadata: {
        generatedAt: Date.now(),
        totalContracts: contracts.length,
        typesCovered: Array.from(typesCovered),
      },
      compactText,
    };
  }

  /**
   * Generate a contract for a specific resource.
   */
  generateForResource(type: ResourceType, name: string): ResourceContract | null {
    const resp = this.serverInterface.get_info(type, name);
    if (!resp.success || !resp.data) return null;

    return this.buildContract(type, name, resp.data);
  }

  /**
   * Build a contract from resource info.
   */
  private buildContract(
    type: ResourceType,
    name: string,
    info: ResourceInfo
  ): ResourceContract {
    const record = info.record;
    const metadata = record.entity.metadata as Record<string, unknown>;

    return {
      resourceName: `${type}:${name}`,
      resourceType: type,
      version: record.version,
      capabilities: this.extractCapabilities(type, record),
      inputs: this.extractInputSpec(record),
      outputs: this.extractOutputSpec(record),
      constraints: this.extractConstraints(type, metadata),
      evolvable: record.entity.evolvability === 1,
      generatedAt: Date.now(),
    };
  }

  /**
   * Extract capability descriptions from a resource.
   */
  private extractCapabilities(
    type: ResourceType,
    record: ResourceRegistrationRecord
  ): string[] {
    const caps: string[] = [];
    const meta = record.entity.metadata as Record<string, unknown>;

    switch (type) {
      case 'Tool':
        caps.push(record.entity.description);
        if (meta.readOnly) caps.push('Read-only operation');
        if (meta.concurrencySafe) caps.push('Concurrency-safe');
        break;

      case 'Prompt':
        caps.push(`System prompt: ${record.entity.description}`);
        if (meta.role) caps.push(`Role: ${meta.role}`);
        if (meta.templateVariables) caps.push(`Variables: ${(meta.templateVariables as string[]).join(', ')}`);
        break;

      case 'Agent':
        caps.push(record.entity.description);
        if (meta.role) caps.push(`Orchestration role: ${meta.role}`);
        if (meta.allowedTools) caps.push(`Tools: ${(meta.allowedTools as string[]).length} available`);
        if (meta.defaultMaxTurns) caps.push(`Max turns: ${meta.defaultMaxTurns}`);
        break;

      case 'Env':
        caps.push(`Execution environment: ${record.entity.description}`);
        if (meta.cwd) caps.push(`Working directory: ${meta.cwd}`);
        if (meta.sandboxBackend) caps.push(`Backend: ${meta.sandboxBackend}`);
        break;

      case 'Mem':
        caps.push(`Memory system: ${record.entity.description}`);
        if (meta.storageBackend) caps.push(`Storage: ${meta.storageBackend}`);
        if (meta.consolidationStrategy) caps.push(`Strategy: ${meta.consolidationStrategy}`);
        break;
    }

    return caps;
  }

  /**
   * Extract input specification.
   */
  private extractInputSpec(record: ResourceRegistrationRecord): ContractIOSpec {
    const inputSchema = record.entity.ioMapping.inputSchema;
    if (!inputSchema) {
      return { schemaType: 'unknown', schema: null, description: 'No input schema defined' };
    }

    if (typeof inputSchema === 'string') {
      return { schemaType: 'text', schema: inputSchema, description: inputSchema };
    }

    return {
      schemaType: 'json-schema',
      schema: inputSchema,
      description: this.schemaToDescription(inputSchema as Record<string, unknown>),
    };
  }

  /**
   * Extract output specification.
   */
  private extractOutputSpec(record: ResourceRegistrationRecord): ContractIOSpec {
    const outputSchema = record.entity.ioMapping.outputSchema;
    if (!outputSchema) {
      return { schemaType: 'unknown', schema: null, description: 'No output schema defined' };
    }

    if (typeof outputSchema === 'string') {
      return { schemaType: 'text', schema: outputSchema, description: outputSchema };
    }

    return {
      schemaType: 'json-schema',
      schema: outputSchema,
      description: this.schemaToDescription(outputSchema as Record<string, unknown>),
    };
  }

  /**
   * Extract constraints from resource metadata.
   */
  private extractConstraints(
    type: ResourceType,
    metadata: Record<string, unknown>
  ): string[] {
    const constraints: string[] = [];

    switch (type) {
      case 'Tool':
        if (metadata.readOnly) constraints.push('Must not modify filesystem or external state');
        if (metadata.priority === 'deferred') constraints.push('Low priority — defer to other tools');
        break;

      case 'Agent':
        if (metadata.deniedTools) constraints.push(`Denied tools: ${(metadata.deniedTools as string[]).join(', ')}`);
        if (metadata.defaultMaxTurns) constraints.push(`Turn limit: ${metadata.defaultMaxTurns}`);
        break;

      case 'Env':
        if (metadata.sandboxBackend === 'local') constraints.push('Local filesystem access only');
        break;

      case 'Mem':
        if (metadata.consolidationStrategy) constraints.push(`Consolidation: ${metadata.consolidationStrategy}`);
        break;
    }

    return constraints;
  }

  /**
   * Generate a compact text representation of all contracts.
   * Suitable for injection into system prompts.
   */
  private generateCompactText(contracts: ResourceContract[]): string {
    if (contracts.length === 0) return 'No resources registered.';

    const lines: string[] = ['## System Capabilities'];

    // Group by type
    const grouped = new Map<ResourceType, ResourceContract[]>();
    for (const c of contracts) {
      if (!grouped.has(c.resourceType)) grouped.set(c.resourceType, []);
      grouped.get(c.resourceType)!.push(c);
    }

    for (const [type, typeContracts] of grouped) {
      lines.push(`\n### ${type}s (${typeContracts.length})`);
      for (const c of typeContracts) {
        const name = c.resourceName.split(':')[1];
        const caps = c.capabilities.slice(0, 2).join('; ');
        const evolvable = c.evolvable ? ' [evolvable]' : '';
        lines.push(`- **${name}**${evolvable}: ${caps}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Convert a JSON Schema-like object to a human description.
   */
  private schemaToDescription(schema: Record<string, unknown>): string {
    const type = schema.type as string;
    if (!type) return 'Unknown schema';

    if (type === 'object' && schema.properties) {
      const props = Object.keys(schema.properties as Record<string, unknown>);
      return `Object with fields: ${props.join(', ')}`;
    }

    if (type === 'array' && schema.items) {
      return `Array of ${this.schemaToDescription(schema.items as Record<string, unknown>)}`;
    }

    return type;
  }
}
