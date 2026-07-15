import { describe, it, expect } from 'vitest';
import { getTheme, THEMES, themeColor, listThemes } from '../../src/ui/theme';

describe('Theme System', () => {
  it('should have 8 built-in themes', () => {
    expect(Object.keys(THEMES)).toHaveLength(8);
    expect(THEMES['dark']).toBeDefined();
    expect(THEMES['light']).toBeDefined();
    expect(THEMES['solarized-dark']).toBeDefined();
    expect(THEMES['monokai']).toBeDefined();
    expect(THEMES['dracula']).toBeDefined();
    expect(THEMES['catppuccin']).toBeDefined();
    expect(THEMES['gruvbox']).toBeDefined();
    expect(THEMES['tokyonight']).toBeDefined();
  });

  it('should get theme by name', () => {
    const dark = getTheme('dark');
    expect(dark.name).toBe('dark');
    expect(dark.colors.primary).toBeTruthy();
    expect(dark.syntax.keyword).toBeTruthy();
    expect(dark.diff.added).toBeTruthy();
  });

  it('should fallback to dark for unknown theme', () => {
    const theme = getTheme('nonexistent');
    expect(theme.name).toBe('dark');
  });

  it('should list all theme names', () => {
    const names = listThemes();
    expect(names).toContain('dark');
    expect(names).toContain('light');
    expect(names).toContain('dracula');
  });

  it('should resolve theme color to chalk function', () => {
    const theme = getTheme('dark');
    const colorFn = themeColor(theme, 'colors.primary');
    expect(typeof colorFn).toBe('function');
  });

  it('should handle nested color paths', () => {
    const theme = getTheme('dark');
    const keywordColor = themeColor(theme, 'syntax.keyword');
    expect(typeof keywordColor).toBe('function');
  });

  it('should fallback to white for unknown paths', () => {
    const theme = getTheme('dark');
    const unknownColor = themeColor(theme, 'nonexistent.path');
    expect(typeof unknownColor).toBe('function');
  });

  it('should get theme 10000 times in <50ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      getTheme('dark');
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
