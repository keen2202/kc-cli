// MCP project-server trust store — round4 §2-S6
//
// `.mcp.json` sits in the project directory, so it travels with the repository:
// cloning an untrusted repo and opening it in kc-cli would otherwise execute
// whatever `command` the repo declares, with no prompt. This store records an
// explicit, per-project approval decision so the prompt is asked once.
//
// User-global servers (`~/.kc-cli/mcp.json`) are NOT gated: the user wrote that
// file themselves on their own machine.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../services/logger';

export interface TrustRecord {
  /** ISO timestamp of the approval. */
  approvedAt: string;
}

export type TrustStoreShape = Record<string, Record<string, TrustRecord>>;

const TRUST_FILE = () => path.join(os.homedir(), '.kc-cli', 'mcp-trust.json');

function readStore(): TrustStoreShape {
  try {
    const raw = fs.readFileSync(TRUST_FILE(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TrustStoreShape;
  } catch {
    // Absent or corrupt store means "nothing trusted" — fail closed.
    return {};
  }
}

function writeStore(store: TrustStoreShape): void {
  try {
    fs.mkdirSync(path.dirname(TRUST_FILE()), { recursive: true });
    fs.writeFileSync(TRUST_FILE(), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    logger.mcp.warn('[MCP trust] failed to persist trust decision', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Record that `serverName` is approved to run inside `projectDir`. */
export function trustServer(projectDir: string, serverName: string): void {
  const store = readStore();
  const dir = path.resolve(projectDir);
  store[dir] = { ...(store[dir] ?? {}), [serverName]: { approvedAt: new Date().toISOString() } };
  writeStore(store);
}

/** True when `serverName` has already been approved for `projectDir`. */
export function isTrusted(projectDir: string, serverName: string): boolean {
  const dir = path.resolve(projectDir);
  return Boolean(readStore()[dir]?.[serverName]);
}

export interface TrustDecision {
  /** Servers cleared to start. */
  approved: Record<string, TrustRecord>;
  /** Servers held back pending an explicit approval. */
  pending: string[];
}

/**
 * Split candidate servers into approved and pending.
 *
 * Interactive mode may prompt; non-interactive mode has no way to ask, so it
 * leaves everything pending (fail-closed) rather than auto-approving.
 */
export function evaluateTrust(
  serverNames: string[],
  projectDir: string,
  options: { interactive: boolean; prompt?: (serverName: string) => boolean } = { interactive: false },
): TrustDecision {
  const store = readStore();
  const dir = path.resolve(projectDir);
  const approved: Record<string, TrustRecord> = {};
  const pending: string[] = [];

  for (const name of serverNames) {
    const existing = store[dir]?.[name];
    if (existing) {
      approved[name] = existing;
      continue;
    }
    if (options.interactive && options.prompt) {
      if (options.prompt(name)) {
        trustServer(projectDir, name);
        approved[name] = { approvedAt: new Date().toISOString() };
        continue;
      }
    }
    pending.push(name);
  }

  return { approved, pending };
}
