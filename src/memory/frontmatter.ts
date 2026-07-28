// YAML frontmatter parser for memory files

import type { MemoryHeader, MemoryType } from './types';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const YAML_LINE_REGEX = /^(\w+):\s*(.*)$/;

/**
 * Parse YAML frontmatter from a memory file content
 * Returns the parsed header and the remaining content
 */
export function parseFrontmatter(content: string): {
  header: Partial<MemoryHeader>;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    // No frontmatter found, return empty header and full content as body
    return {
      header: {},
      body: content,
    };
  }

  const [, yamlBlock, body] = match;
  const header = parseYamlBlock(yamlBlock);

  return {
    header,
    body: body.trim(),
  };
}

/**
 * Parse a YAML block into a MemoryHeader object
 * Simple parser - handles basic key: value pairs
 */
function parseYamlBlock(yaml: string): Partial<MemoryHeader> {
  const header: Partial<MemoryHeader> = {};
  const lines = yaml.split('\n');

  for (const line of lines) {
    const match = line.match(YAML_LINE_REGEX);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseYamlValue(rawValue);

    switch (key) {
      case 'name':
        header.name = value as string;
        break;
      case 'description':
        header.description = value as string;
        break;
      case 'type':
        header.type = validateMemoryType(value as string);
        break;
      case 'createdAt':
        header.createdAt = typeof value === 'number' ? value : parseInt(value as string, 10);
        break;
      case 'updatedAt':
        header.updatedAt = typeof value === 'number' ? value : parseInt(value as string, 10);
        break;
      case 'confidence':
        if (value === 'low' || value === 'high') {
          header.confidence = value;
        }
        break;
      // T8: failure signature is serialized as flat keys (parser is flat-only)
      case 'signatureTerminalCause':
        header.signature = { ...(header.signature ?? { terminalCause: '', mechanism: '' }), terminalCause: String(value) };
        break;
      case 'signatureMechanism':
        header.signature = { ...(header.signature ?? { terminalCause: '', mechanism: '' }), mechanism: String(value) };
        break;
      case 'signatureCount': {
        const count = typeof value === 'number' ? value : parseInt(value as string, 10);
        if (!isNaN(count)) {
          header.signature = { ...(header.signature ?? { terminalCause: '', mechanism: '' }), count };
        }
        break;
      }
    }
  }

  return header;
}

/**
 * Parse a YAML value string into its appropriate type
 */
function parseYamlValue(raw: string): string | number {
  let value = raw.trim();

  // Remove quotes if present
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Try to parse as number
  const numValue = Number(value);
  if (!isNaN(numValue)) {
    return numValue;
  }

  return value;
}

// Module-level Set for O(1) type validation (avoids array allocation per call)
const VALID_MEMORY_TYPES = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);

/**
 * Validate and coerce a string to MemoryType
 * Returns undefined for unrecognized types
 */
export function validateMemoryType(type: string): MemoryType | undefined {
  const normalized = type.toLowerCase().trim();

  if (VALID_MEMORY_TYPES.has(normalized as MemoryType)) {
    return normalized as MemoryType;
  }

  return undefined;
}

/**
 * Generate YAML frontmatter from a MemoryHeader object
 */
export function generateFrontmatter(header: MemoryHeader): string {
  const lines = ['---'];

  lines.push(`name: ${escapeYamlValue(header.name)}`);
  lines.push(`description: ${escapeYamlValue(header.description)}`);
  lines.push(`type: ${header.type}`);

  if (header.createdAt) {
    lines.push(`createdAt: ${header.createdAt}`);
  }
  if (header.updatedAt) {
    lines.push(`updatedAt: ${header.updatedAt}`);
  }
  if (header.confidence) {
    lines.push(`confidence: ${header.confidence}`);
  }
  // T8: flat signature keys (the frontmatter parser has no nested-object support)
  if (header.signature) {
    lines.push(`signatureTerminalCause: ${escapeYamlValue(header.signature.terminalCause)}`);
    lines.push(`signatureMechanism: ${escapeYamlValue(header.signature.mechanism)}`);
    if (header.signature.count !== undefined) {
      lines.push(`signatureCount: ${header.signature.count}`);
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

// Single regex to detect YAML special characters (replaces 16 sequential includes() calls)
// Matches: special chars anywhere, or leading/trailing spaces/quotes
const YAML_SPECIAL_CHARS = /[:#,\[\]{}&*?|<>=!%@\\\-]|^ | $|^["']/;

/**
 * Escape a value for YAML if needed
 */
function escapeYamlValue(value: string): string {
  // Single regex test instead of 16 sequential includes() calls
  if (YAML_SPECIAL_CHARS.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return value;
}

/**
 * Compose a complete memory file from header and content
 */
export function composeMemoryFile(header: MemoryHeader, content: string): string {
  const frontmatter = generateFrontmatter(header);
  return `${frontmatter}${content}\n`;
}

/**
 * Parse a complete memory file into header and content
 */
export function parseMemoryFile(content: string): {
  header: Partial<MemoryHeader>;
  body: string;
} {
  return parseFrontmatter(content);
}
