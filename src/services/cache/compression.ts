// Adaptive cache compression
// Content-aware compression with level adaptation based on cache tier and content characteristics

import { createHash } from 'crypto';

export interface CompressionResult {
  data: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  algorithm: string;
}

// Thresholds for compression decisions
const MIN_SIZE_FOR_COMPRESSION = 256; // Don't compress small entries
const JSON_COMPRESSION_THRESHOLD = 512; // JSON above this gets compressed
const HIGH_REDUNDANCY_THRESHOLD = 0.3; // Ratio of unique chars to total

/**
 * Adaptive compression for cache entries
 * Chooses strategy based on content type and size
 */
export function compressForCache<V>(value: V, tier: 'hot' | 'warm' | 'cold' = 'warm'): {
  compressed: string;
  wasCompressed: boolean;
  originalSize: number;
  compressedSize: number;
} {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const originalSize = serialized.length * 2; // UTF-16

  // Skip compression for small entries in hot tier
  if (tier === 'hot' && originalSize < MIN_SIZE_FOR_COMPRESSION) {
    return { compressed: serialized, wasCompressed: false, originalSize, compressedSize: originalSize };
  }

  // Skip compression for medium entries in warm tier
  if (tier === 'warm' && originalSize < JSON_COMPRESSION_THRESHOLD) {
    return { compressed: serialized, wasCompressed: false, originalSize, compressedSize: originalSize };
  }

  // Check if content has enough redundancy to benefit from compression
  const redundancy = estimateRedundancy(serialized);
  if (redundancy < HIGH_REDUNDANCY_THRESHOLD) {
    // Low redundancy - compression won't help much
    return { compressed: serialized, wasCompressed: false, originalSize, compressedSize: originalSize };
  }

  // Apply dictionary-based compression for JSON-like content
  const compressed = dictionaryCompress(serialized);
  const compressedSize = compressed.length * 2;

  // Only use compressed version if it's actually smaller
  if (compressedSize < originalSize * 0.8) {
    return { compressed, wasCompressed: true, originalSize, compressedSize };
  }

  return { compressed: serialized, wasCompressed: false, originalSize, compressedSize: originalSize };
}

/**
 * Decompress a cache entry
 */
export function decompressFromCache<V>(data: string, wasCompressed: boolean): V {
  if (!wasCompressed) {
    try {
      return JSON.parse(data) as V;
    } catch {
      return data as unknown as V;
    }
  }

  const decompressed = dictionaryDecompress(data);
  try {
    return JSON.parse(decompressed) as V;
  } catch {
    return decompressed as unknown as V;
  }
}

/**
 * Dictionary-based compression for repetitive JSON content
 * Replaces common JSON patterns with shorter tokens
 */
function dictionaryCompress(text: string): string {
  // Find repeated substrings and replace with references
  const patterns = findRepeatedPatterns(text);
  if (patterns.length === 0) return text;

  let compressed = text;
  const dictionary: string[] = [];

  for (const pattern of patterns) {
    const dictIdx = dictionary.length;
    dictionary.push(pattern);
    // Use \x01 as escape, followed by index as varint
    const token = `\x01${String.fromCharCode(dictIdx + 32)}`;
    compressed = compressed.split(pattern).join(token);
  }

  // Prepend dictionary: \x02 + count + \x03 + entries separated by \x03
  const dictHeader = `\x02${String.fromCharCode(dictionary.length + 32)}\x03${dictionary.join('\x03')}\x03`;
  return dictHeader + compressed;
}

function dictionaryDecompress(text: string): string {
  if (!text.startsWith('\x02')) return text;

  // Parse dictionary header
  const headerEnd = text.indexOf('\x03', 3);
  if (headerEnd === -1) return text;

  const dictCount = text.charCodeAt(1) - 32;
  const dictData = text.slice(3, headerEnd);
  const dictionary = dictData.split('\x03');

  let decompressed = text.slice(headerEnd + 1);

  // Replace tokens back
  for (let i = dictionary.length - 1; i >= 0; i--) {
    const token = `\x01${String.fromCharCode(i + 32)}`;
    decompressed = decompressed.split(token).join(dictionary[i]!);
  }

  return decompressed;
}

/**
 * Find repeated substrings worth compressing
 */
function findRepeatedPatterns(text: string): string[] {
  const patterns: { pattern: string; count: number; savings: number }[] = [];
  const seen = new Set<string>();

  // Look for repeated substrings of length 4-50
  for (let len = 4; len <= Math.min(50, text.length / 4); len++) {
    for (let i = 0; i <= text.length - len; i++) {
      const substr = text.slice(i, i + len);
      if (seen.has(substr)) continue;
      seen.add(substr);

      // Count occurrences
      let count = 0;
      let pos = 0;
      while ((pos = text.indexOf(substr, pos)) !== -1) {
        count++;
        pos += len;
      }

      // Worth compressing if it appears 3+ times and saves space
      if (count >= 3) {
        const savings = (count - 1) * (len - 3); // Each replacement saves (len - 3) chars
        if (savings > 10) {
          patterns.push({ pattern: substr, count, savings });
        }
      }
    }
  }

  // Sort by savings and take top patterns
  patterns.sort((a, b) => b.savings - a.savings);
  return patterns.slice(0, 90).map((p) => p.pattern); // Max 90 patterns (single-byte index)
}

/**
 * Estimate content redundancy (0 = random, 1 = fully repetitive)
 */
function estimateRedundancy(text: string): number {
  if (text.length < 10) return 0;

  // Simple heuristic: ratio of unique 3-grams to total 3-grams
  const trigrams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.add(text.slice(i, i + 3));
  }

  const maxTrigrams = text.length - 2;
  return 1 - trigrams.size / maxTrigrams;
}

/**
 * Create a stable hash for cache key generation
 */
export function stableHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
