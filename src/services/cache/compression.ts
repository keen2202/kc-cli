// Cache utilities - stable hashing

import { createHash } from 'crypto';

/**
 * Create a stable hash for cache key generation
 */
export function stableHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
