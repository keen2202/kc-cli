/**
 * Tests for slash command normalization (Chinese alias mapping).
 */

import { describe, it, expect } from 'vitest';
import { normalizeSlashCommand } from '../../src/ui/components/slash-commands';

describe('normalizeSlashCommand', () => {
  it('maps Chinese aliases to their English command', () => {
    expect(normalizeSlashCommand('/帮助')).toBe('/help');
    expect(normalizeSlashCommand('/清空')).toBe('/clear');
    expect(normalizeSlashCommand('/清除')).toBe('/clear');
    expect(normalizeSlashCommand('/模式')).toBe('/mode');
    expect(normalizeSlashCommand('/工具')).toBe('/tools');
    expect(normalizeSlashCommand('/状态')).toBe('/status');
    expect(normalizeSlashCommand('/级别')).toBe('/level');
    expect(normalizeSlashCommand('/退出')).toBe('/exit');
    expect(normalizeSlashCommand('/密钥')).toBe('/key');
  });

  it('maps the execution-mode aliases', () => {
    expect(normalizeSlashCommand('/自动')).toBe('/auto');
    expect(normalizeSlashCommand('/目标')).toBe('/goal');
    expect(normalizeSlashCommand('/交互')).toBe('/interactive');
  });

  it('returns English commands unchanged', () => {
    expect(normalizeSlashCommand('/help')).toBe('/help');
    expect(normalizeSlashCommand('/clear')).toBe('/clear');
    expect(normalizeSlashCommand('/exit')).toBe('/exit');
  });

  it('returns unknown commands unchanged (falls through to default handling)', () => {
    expect(normalizeSlashCommand('/搜索')).toBe('/搜索');
    expect(normalizeSlashCommand('/设置')).toBe('/设置');
    expect(normalizeSlashCommand('/bogus')).toBe('/bogus');
  });
});
