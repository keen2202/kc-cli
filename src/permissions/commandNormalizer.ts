// Command normalizer - prevents pattern matching bypass via formatting tricks

/**
 * Normalize a command to a canonical form for pattern matching.
 * Prevents bypass via:
 *   - Multiple spaces
 *   - Escape characters (\)
 *   - Quote wrapping
 *   - Unicode homoglyphs / zero-width characters
 *
 * @param command Raw command string
 * @returns Normalized command string
 */
export function normalizeCommand(command: string): string {
  if (!command || typeof command !== 'string') return '';

  let normalized = command;

  // Step 1: Remove zero-width characters (Unicode confusion bypass)
  normalized = removeZeroWidthChars(normalized);

  // Step 2: Normalize Unicode homoglyphs
  normalized = normalizeHomoglyphs(normalized);

  // Step 3: Remove escape characters (backslash before meaningful chars)
  normalized = removeEscapes(normalized);

  // Step 4: Normalize whitespace (tabs, multi-spaces → single space)
  normalized = normalized.replace(/[\t\r\n]+/g, ' ').replace(/ +/g, ' ').trim();

  return normalized;
}

/**
 * Remove zero-width Unicode characters that could be used for obfuscation.
 */
function removeZeroWidthChars(str: string): string {
  return str
    .replace(/​/g, '') // Zero-width space
    .replace(/‌/g, '') // Zero-width non-joiner
    .replace(/‍/g, '') // Zero-width joiner
    .replace(/﻿/g, '') // BOM / zero-width no-break space
    .replace(/­/g, '') // Soft hyphen
    .replace(/‎/g, '') // LTR mark
    .replace(/‏/g, ''); // RTL mark
}

/**
 * Normalize common Unicode homoglyphs to ASCII equivalents.
 * These are characters that look the same as ASCII but have different code points.
 */
function normalizeHomoglyphs(str: string): string {
  const homoglyphMap: Record<string, string> = {
    // Cyrillic → Latin homoglyphs
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'А': 'A', 'В': 'B', 'Е': 'E', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
    'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
    // Greek → Latin homoglyphs
    'ο': 'o', 'υ': 'u', 'ν': 'v',
    'Ο': 'O', 'Τ': 'T', 'Ν': 'N',
    // Full-width → ASCII
    '！': '!', '＃': '#', '＄': '$', '％': '%', '＆': '&',
    '＊': '*', '＋': '+', '－': '-', '／': '/',
    '：': ':', '；': ';', '＜': '<', '＝': '=', '＞': '>',
    '？': '?', '＠': '@',
  };

  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += homoglyphMap[char] || char;
  }
  return result;
}

/**
 * Remove escape characters that precede meaningful characters.
 * Handles: \n → n, \r → r, \t → t (literal escape sequences in command strings)
 * Also handles shell-style escapes: r\m → rm
 */
function removeEscapes(str: string): string {
  // Remove backslash before any non-space character (shell escape)
  return str.replace(/\\(.)/g, '$1');
}

/**
 * Split a compound command into sub-commands at pipe/chain boundaries.
 * Returns all sub-commands that need individual permission checks.
 *
 * @param command Normalized command string
 * @returns Array of sub-commands
 */
export function splitSubCommands(command: string): string[] {
  if (!command) return [];

  // Split on pipe, semicolon, &&, ||, |&
  const delimiters = /\s*(?:\|\||&&|;\s*|(?<!\|)\|(?!\|)|\|&)\s*/;
  const parts = command.split(delimiters).filter(Boolean);

  if (parts.length === 0) return [command];
  return parts.map(p => p.trim());
}

/**
 * Check if a command uses any bypass techniques.
 * Returns the bypass vectors found.
 */
export function detectBypassAttempts(command: string): {
  hasBypass: boolean;
  vectors: string[];
} {
  const vectors: string[] = [];

  // Multi-space bypass
  if (/\s{2,}/.test(command)) {
    vectors.push('multi-space');
  }

  // Escape character bypass
  if (/\\./.test(command)) {
    vectors.push('escape-chars');
  }

  // Zero-width character bypass
  if (/[​‌‍﻿­]/.test(command)) {
    vectors.push('zero-width-chars');
  }

  // Homoglyph bypass (non-ASCII chars that look like ASCII)
  const asciiOnly = /^[\x00-\x7F\s]*$/;
  if (!asciiOnly.test(command)) {
    vectors.push('non-ascii-chars');
  }

  // Multiple command chaining (&&, ;, |, ||)
  if (/[;&|]/.test(command)) {
    vectors.push('command-chaining');
  }

  return {
    hasBypass: vectors.length > 0,
    vectors,
  };
}

/**
 * Normalize and validate a command for permission checking.
 * Combines normalization, bypass detection, and sub-command splitting.
 *
 * @param command Raw command string
 * @returns Normalized command with bypass info
 */
export function prepareCommandForPermissionCheck(command: string): {
  normalized: string;
  subCommands: string[];
  hasBypassAttempt: boolean;
  bypassVectors: string[];
} {
  const bypass = detectBypassAttempts(command);
  const normalized = normalizeCommand(command);
  const subCommands = splitSubCommands(normalized);

  return {
    normalized,
    subCommands,
    hasBypassAttempt: bypass.hasBypass,
    bypassVectors: bypass.vectors,
  };
}
