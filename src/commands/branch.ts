// Branch management CLI commands for session tree

import chalk from 'chalk';
import type { QueryEngine } from '../query/QueryEngine';

/**
 * Handle /branch command.
 * Without args: list all branches.
 * With arg: create a new branch with optional label.
 */
export function handleBranch(queryEngine: QueryEngine, label?: string): void {
  if (label) {
    const nodeId = queryEngine.branch();
    const tree = queryEngine.getTree();
    const node = tree.find(n => n.id === nodeId);
    if (node) {
      // Use the conversation state to set label
      queryEngine.getSessionTree?.()?.setBranchLabel(nodeId, label);
    }
    console.log(chalk.green(`Created branch: ${nodeId.slice(0, 8)} (${label})`));
  } else {
    listBranches(queryEngine);
  }
}

/**
 * Handle /checkout <id> command.
 * Switches to a different branch by ID (full or prefix match).
 */
export function handleCheckout(queryEngine: QueryEngine, nodeId: string): void {
  const tree = queryEngine.getTree();

  // Try exact match first, then prefix match
  let target = tree.find(n => n.id === nodeId);
  if (!target) {
    target = tree.find(n => n.id.startsWith(nodeId));
  }

  if (!target) {
    console.log(chalk.red(`Branch not found: ${nodeId}`));
    return;
  }

  try {
    queryEngine.checkout(target.id);
    const label = target.label ? ` (${target.label})` : '';
    console.log(chalk.green(`Switched to branch: ${target.id.slice(0, 8)}${label}`));
  } catch (err) {
    console.log(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
  }
}

/**
 * Handle /history command.
 * Displays the conversation tree as a visual tree.
 */
export function handleHistory(queryEngine: QueryEngine): void {
  const tree = queryEngine.getTree();
  const activeId = tree.find(n => {
    // Find active node by checking which one has no children pointing to a "next" node
    // Actually, we need the active node ID from the tree
    return false;
  });

  // Build parent-children map
  const childrenMap = new Map<string, typeof tree>();
  for (const node of tree) {
    const pid = node.parentId ?? '__root__';
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid)!.push(node);
  }

  // Find root
  const root = tree.find(n => n.parentId === null);
  if (!root) {
    console.log(chalk.gray('No conversation history.'));
    return;
  }

  // Get active node ID from the tree by checking the conversation state
  const activeNodeId = getActiveNodeId(queryEngine);

  console.log(chalk.bold('\nConversation Tree:\n'));
  printNode(root, '', true, activeNodeId, childrenMap);
  console.log();
}

/**
 * List all branches with their info.
 */
function listBranches(queryEngine: QueryEngine): void {
  const tree = queryEngine.getTree();
  const activeNodeId = getActiveNodeId(queryEngine);

  console.log(chalk.bold('\nBranches:\n'));

  for (const node of tree) {
    const isActive = node.id === activeNodeId;
    const prefix = isActive ? chalk.green(' * ') : '   ';
    const id = node.id.slice(0, 8);
    const label = node.label ? chalk.cyan(` [${node.label}]`) : '';
    const msgCount = node.messages.length;
    const parent = node.parentId ? node.parentId.slice(0, 8) : 'root';
    const active = isActive ? chalk.green(' (active)') : '';

    console.log(`${prefix}${id}${label} - ${msgCount} msgs, branched from ${parent}${active}`);
  }
  console.log();
}

/**
 * Get the active node ID from the query engine.
 */
function getActiveNodeId(queryEngine: QueryEngine): string {
  const tree = queryEngine.getTree();
  const messages = queryEngine.getMessages();

  // The active node is the one whose messages are at the end of the full message list.
  // We find it by checking which leaf node's accumulated messages match.
  // Simpler: find the node that is a leaf (no children) and whose accumulated messages
  // match the current message count. If multiple leaves, the active one is the last
  // one that was checked out. We can approximate by finding nodes with no children.
  const childIds = new Set(tree.filter(n => n.parentId !== null).map(n => n.parentId));
  const leaves = tree.filter(n => !childIds.has(n.id));

  // Among leaves, find the one whose message chain matches
  for (const leaf of leaves) {
    const chain = getNodeChain(tree, leaf.id);
    let total = 0;
    for (const n of chain) total += n.messages.length;
    if (total === messages.length) return leaf.id;
  }

  // Fallback: return the last leaf
  return leaves.length > 0 ? leaves[leaves.length - 1].id : tree[0].id;
}

/**
 * Get the chain of nodes from root to a given node.
 */
function getNodeChain(tree: ReturnType<QueryEngine['getTree']>, nodeId: string): typeof tree {
  const map = new Map(tree.map(n => [n.id, n]));
  const chain: typeof tree = [];
  let current = map.get(nodeId);
  while (current) {
    chain.push(current);
    current = current.parentId ? map.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

/**
 * Recursively print a tree node with ASCII art.
 */
function printNode(
  node: { id: string; label?: string; messages: { length: number }; parentId: string | null },
  indent: string,
  isLast: boolean,
  activeNodeId: string,
  childrenMap: Map<string, typeof node[]>
): void {
  const connector = isLast ? '\\-- ' : '|-- ';
  const isActive = node.id === activeNodeId;
  const id = node.id.slice(0, 8);
  const label = node.label ? ` [${node.label}]` : '';
  const msgInfo = `${node.messages.length} msgs`;
  const activeMarker = isActive ? chalk.green(' <-- active') : '';

  const nameStr = isActive ? chalk.green(`${id}${label}`) : `${id}${label}`;
  console.log(`${indent}${connector}${nameStr} (${msgInfo})${activeMarker}`);

  const children = childrenMap.get(node.id) ?? [];
  const childIndent = indent + (isLast ? '    ' : '|   ');

  for (let i = 0; i < children.length; i++) {
    printNode(children[i], childIndent, i === children.length - 1, activeNodeId, childrenMap);
  }
}
