/**
 * T6 residual backlog — S5 dangerous-command bypass + B6 branch token total.
 */
import { describe, it, expect } from 'vitest';
import {
  joinEmptyQuoteSplits,
  decodeAnsiCQuotes,
  expandShellWordSplits,
  normalizeCommand,
} from '../../src/permissions/commandNormalizer';
import {
  isDangerousBashCommand,
  shellAwareNormalize,
} from '../../src/permissions/readonlyCommands';
import { ConversationState } from '../../src/query/QueryEngineState';
import type { ChatMessage } from '../../src/query/protocol';

describe('T6-B1 empty quote word-glue', () => {
  it('joins r\'\'m into rm', () => {
    expect(joinEmptyQuoteSplits("r''m -rf /")).toBe('rm -rf /');
    expect(joinEmptyQuoteSplits('r""m -rf /')).toBe('rm -rf /');
    expect(joinEmptyQuoteSplits("r''m'' -rf /")).toBe('rm -rf /');
  });

  it('does not join non-empty quotes (false-positive guard)', () => {
    expect(joinEmptyQuoteSplits("echo 'rm -rf /'")).toBe("echo 'rm -rf /'");
  });

  it('isDangerousBashCommand catches quote-split rm -rf', () => {
    expect(isDangerousBashCommand("r''m -rf /")).toBe(true);
    expect(isDangerousBashCommand('r""m -rf /')).toBe(true);
    expect(isDangerousBashCommand("r''m -R -f /tmp")).toBe(true);
  });

  it('still allows echo of dangerous text inside quotes', () => {
    expect(isDangerousBashCommand('echo "rm -rf /"')).toBe(false);
    expect(isDangerousBashCommand("echo 'mkfs'")).toBe(false);
  });
});

describe('T6-B2 ANSI-C quotes', () => {
  it('decodes simple escapes', () => {
    expect(decodeAnsiCQuotes("$'rm'")).toBe('rm');
    expect(decodeAnsiCQuotes("$'r\\x6d'")).toBe('rm');
    expect(decodeAnsiCQuotes("$'r\\155'")).toBe('rm'); // octal 155 = m
    expect(decodeAnsiCQuotes("$'rm\\n-rf'")).toBe('rm\n-rf');
  });

  it('isDangerousBashCommand catches ANSI-C encoded rm', () => {
    expect(isDangerousBashCommand("$'r\\x6d' -rf /")).toBe(true);
    expect(isDangerousBashCommand("$'\\x72\\x6d' -rf /tmp")).toBe(true);
  });

  it('expandShellWordSplits combines empty quotes and ANSI-C', () => {
    expect(expandShellWordSplits("r''m")).toBe('rm');
    expect(expandShellWordSplits("$'rm'")).toBe('rm');
  });
});

describe('T6-B1/B2 regression: prior coverage preserved', () => {
  it('pipe-to-shell still dangerous', () => {
    expect(isDangerousBashCommand('echo hi | bash')).toBe(true);
    expect(isDangerousBashCommand('cat x | sh')).toBe(true);
  });

  it('base64 decode still dangerous', () => {
    expect(isDangerousBashCommand('echo ZWNobyB4 | base64 -d')).toBe(true);
  });

  it('mkfs / chmod 777 / shutdown still dangerous', () => {
    expect(isDangerousBashCommand('mkfs.ext4 /dev/sda1')).toBe(true);
    expect(isDangerousBashCommand('chmod 777 /etc/passwd')).toBe(true);
    expect(isDangerousBashCommand('shutdown -h now')).toBe(true);
  });

  it('plain readonly commands stay safe', () => {
    expect(isDangerousBashCommand('ls -la')).toBe(false);
    expect(isDangerousBashCommand('grep -n foo src/main.ts')).toBe(false);
  });

  it('shellAwareNormalize still strips non-empty quotes', () => {
    expect(shellAwareNormalize('echo "hello world"')).toContain('echo');
    expect(shellAwareNormalize('echo "hello world"')).not.toContain('hello');
  });

  it('normalizeCommand still collapses whitespace and escapes', () => {
    expect(normalizeCommand('r\\m    -rf   /')).toBe('rm -rf /');
  });
});

describe('T6-B6 branch keeps running token total', () => {
  function msg(role: ChatMessage['role'], content: string): ChatMessage {
    return { role, content } as ChatMessage;
  }

  it('branch() does not zero the running total', () => {
    const state = new ConversationState();
    state.addMessage(msg('user', 'hello world this is a long enough message'));
    state.addMessage(msg('assistant', 'reply with more tokens here'));
    const before = state.getTokenEstimate();
    expect(before).toBeGreaterThan(0);

    state.branch();
    // Leaf is empty but parent chain remains — total must be preserved.
    expect(state.getTokenEstimate()).toBe(before);
  });

  it('checkout() restores the other branch total', () => {
    const state = new ConversationState();
    state.addMessage(msg('user', 'first branch user message with some tokens'));
    const firstTotal = state.getTokenEstimate();

    const branchId = state.branch();
    state.addMessage(msg('user', 'second branch extra message with more tokens'));
    const secondTotal = state.getTokenEstimate();
    expect(secondTotal).toBeGreaterThan(firstTotal);

    // Back to root (need root id — checkout to parent via tree root).
    const tree = state.getSessionTree();
    const rootId = tree.getNode(branchId)?.parentId;
    expect(rootId).toBeTruthy();
    state.checkout(rootId!);
    expect(state.getTokenEstimate()).toBe(firstTotal);

    state.checkout(branchId);
    expect(state.getTokenEstimate()).toBe(secondTotal);
  });

  it('getMessages() after branch still returns the full conversation', () => {
    const state = new ConversationState();
    state.addMessage(msg('user', 'hello'));
    state.addMessage(msg('assistant', 'hi'));
    state.branch();
    const msgs = state.getMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});
