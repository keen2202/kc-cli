// Theme system for terminal UI
// Provides configurable colors with built-in themes.

import chalk from 'chalk';

export interface ThemeColors {
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  border: string;
  background: string;
  highlight: string;
}

export interface ThemeSyntax {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
}

export interface ThemeDiff {
  added: string;
  removed: string;
  context: string;
}

/**
 * Semantic theme tokens for UI components.
 * Each token maps to a chalk color function.
 */
export interface ThemeTokens {
  'header.brand': typeof chalk;
  'header.model': typeof chalk;
  'chat.user': typeof chalk;
  'chat.assistant': typeof chalk;
  'chat.system': typeof chalk;
  'chat.timestamp': typeof chalk;
  'tool.running': typeof chalk;
  'tool.success': typeof chalk;
  'tool.failed': typeof chalk;
  'tool.name': typeof chalk;
  'sidebar.background': typeof chalk;
  'sidebar.tab.active': typeof chalk;
  'sidebar.tab.inactive': typeof chalk;
  'status.model': typeof chalk;
  'status.tokens': typeof chalk;
  'status.duration': typeof chalk;
  'input.prompt': typeof chalk;
  'input.text': typeof chalk;
  'input.steer': typeof chalk;
  'diff.added': typeof chalk;
  'diff.removed': typeof chalk;
  'diff.context': typeof chalk;
  'overlay.background': typeof chalk;
  'overlay.border': typeof chalk;
  'overlay.selected': typeof chalk;
  'error.text': typeof chalk;
  'warning.text': typeof chalk;
  'thinking.label': typeof chalk;
  'thinking.content': typeof chalk;
  'thinking.step': typeof chalk;
  'thinking.folded': typeof chalk;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  syntax: ThemeSyntax;
  diff: ThemeDiff;
  resolve(): ThemeTokens;
}

// Built-in themes

function buildResolver(t: Theme): () => ThemeTokens {
  return () => ({
    'header.brand': chalk.hex(t.colors.primary).bold,
    'header.model': chalk.hex(t.colors.muted),
    'chat.user': chalk.hex(t.colors.primary).bold,
    'chat.assistant': chalk.hex(t.colors.success),
    'chat.system': chalk.hex(t.colors.muted).dim,
    'chat.timestamp': chalk.hex(t.colors.muted).dim,
    'tool.running': chalk.hex(t.colors.warning),
    'tool.success': chalk.hex(t.colors.success),
    'tool.failed': chalk.hex(t.colors.error),
    'tool.name': chalk.hex(t.colors.primary).bold,
    'sidebar.background': chalk.hex(t.colors.border),
    'sidebar.tab.active': chalk.hex(t.colors.primary).bold,
    'sidebar.tab.inactive': chalk.hex(t.colors.muted).dim,
    'status.model': chalk.hex(t.colors.primary),
    'status.tokens': chalk.hex(t.colors.muted),
    'status.duration': chalk.hex(t.colors.muted),
    'input.prompt': chalk.hex(t.colors.primary).bold,
    'input.text': chalk.white,
    'input.steer': chalk.hex(t.colors.warning).bold,
    'diff.added': chalk.hex(t.colors.success),
    'diff.removed': chalk.hex(t.colors.error),
    'diff.context': chalk.hex(t.colors.muted),
    'overlay.background': chalk.hex(t.colors.background),
    'overlay.border': chalk.hex(t.colors.border),
    'overlay.selected': chalk.hex(t.colors.highlight).bold,
    'error.text': chalk.hex(t.colors.error),
    'warning.text': chalk.hex(t.colors.warning),
    'thinking.label': chalk.hex(t.colors.secondary).bold,
    'thinking.content': chalk.hex(t.colors.muted).dim,
    'thinking.step': chalk.hex(t.colors.secondary),
    'thinking.folded': chalk.hex(t.colors.muted),
  });
}

const darkTheme: Theme = {
  name: 'dark',
  colors: {
    primary: '#61afef',
    secondary: '#c678dd',
    success: '#98c379',
    warning: '#e5c07b',
    error: '#e06c75',
    muted: '#5c6370',
    border: '#3e4451',
    background: '#282c34',
    highlight: '#528bff',
  },
  syntax: {
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    comment: '#5c6370',
    function: '#61afef',
  },
  diff: {
    added: '#98c379',
    removed: '#e06c75',
    context: '#5c6370',
  },
  resolve: null as unknown as () => ThemeTokens,
};

const lightTheme: Theme = {
  name: 'light',
  colors: {
    primary: '#2563eb',
    secondary: '#7c3aed',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
    muted: '#9ca3af',
    border: '#d1d5db',
    background: '#ffffff',
    highlight: '#3b82f6',
  },
  syntax: {
    keyword: '#7c3aed',
    string: '#16a34a',
    number: '#ca8a04',
    comment: '#9ca3af',
    function: '#2563eb',
  },
  diff: {
    added: '#16a34a',
    removed: '#dc2626',
    context: '#9ca3af',
  },
  resolve: null as unknown as () => ThemeTokens,
};

const solarizedDarkTheme: Theme = {
  name: 'solarized-dark',
  colors: {
    primary: '#268bd2',
    secondary: '#6c71c4',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    muted: '#586e75',
    border: '#073642',
    background: '#002b36',
    highlight: '#2aa198',
  },
  syntax: {
    keyword: '#859900',
    string: '#2aa198',
    number: '#d33682',
    comment: '#586e75',
    function: '#268bd2',
  },
  diff: {
    added: '#859900',
    removed: '#dc322f',
    context: '#586e75',
  },
  resolve: null as unknown as () => ThemeTokens,
};

const monokaiTheme: Theme = {
  name: 'monokai',
  colors: {
    primary: '#66d9ef',
    secondary: '#ae81ff',
    success: '#a6e22e',
    warning: '#e6db74',
    error: '#f92672',
    muted: '#75715e',
    border: '#3e3d32',
    background: '#272822',
    highlight: '#fd971f',
  },
  syntax: {
    keyword: '#f92672',
    string: '#e6db74',
    number: '#ae81ff',
    comment: '#75715e',
    function: '#a6e22e',
  },
  diff: {
    added: '#a6e22e',
    removed: '#f92672',
    context: '#75715e',
  },
  resolve: null as unknown as () => ThemeTokens,
};

const draculaTheme: Theme = {
  name: 'dracula',
  colors: {
    primary: '#bd93f9',
    secondary: '#ff79c6',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    muted: '#6272a4',
    border: '#44475a',
    background: '#282a36',
    highlight: '#8be9fd',
  },
  syntax: {
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    comment: '#6272a4',
    function: '#50fa7b',
  },
  diff: {
    added: '#50fa7b',
    removed: '#ff5555',
    context: '#6272a4',
  },
  resolve: null as unknown as () => ThemeTokens,
};

// Catppuccin Mocha theme
const catppuccinTheme: Theme = {
  name: 'catppuccin',
  colors: {
    primary: '#89b4fa',
    secondary: '#cba6f7',
    success: '#a6e3a1',
    warning: '#f9e2af',
    error: '#f38ba8',
    muted: '#6c7086',
    border: '#45475a',
    background: '#1e1e2e',
    highlight: '#89dceb',
  },
  syntax: {
    keyword: '#cba6f7',
    string: '#a6e3a1',
    number: '#fab387',
    comment: '#6c7086',
    function: '#89b4fa',
  },
  diff: {
    added: '#a6e3a1',
    removed: '#f38ba8',
    context: '#6c7086',
  },
  resolve: null as unknown as () => ThemeTokens,
};

// Gruvbox Dark theme
const gruvboxTheme: Theme = {
  name: 'gruvbox',
  colors: {
    primary: '#83a598',
    secondary: '#d3869b',
    success: '#b8bb26',
    warning: '#fabd2f',
    error: '#fb4934',
    muted: '#928374',
    border: '#504945',
    background: '#282828',
    highlight: '#fe8019',
  },
  syntax: {
    keyword: '#fb4934',
    string: '#b8bb26',
    number: '#d3869b',
    comment: '#928374',
    function: '#83a598',
  },
  diff: {
    added: '#b8bb26',
    removed: '#fb4934',
    context: '#928374',
  },
  resolve: null as unknown as () => ThemeTokens,
};

// Tokyonight theme (opencode default)
const tokyonightTheme: Theme = {
  name: 'tokyonight',
  colors: {
    primary: '#7aa2f7',
    secondary: '#bb9af7',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    muted: '#565f89',
    border: '#3b4261',
    background: '#1a1b26',
    highlight: '#2ac3de',
  },
  syntax: {
    keyword: '#bb9af7',
    string: '#9ece6a',
    number: '#ff9e64',
    comment: '#565f89',
    function: '#7aa2f7',
  },
  diff: {
    added: '#9ece6a',
    removed: '#f7768e',
    context: '#565f89',
  },
  resolve: null as unknown as () => ThemeTokens,
};

// Patch resolve() onto each theme (deferred to avoid circular init)
darkTheme.resolve = buildResolver(darkTheme);
lightTheme.resolve = buildResolver(lightTheme);
solarizedDarkTheme.resolve = buildResolver(solarizedDarkTheme);
monokaiTheme.resolve = buildResolver(monokaiTheme);
draculaTheme.resolve = buildResolver(draculaTheme);
catppuccinTheme.resolve = buildResolver(catppuccinTheme);
gruvboxTheme.resolve = buildResolver(gruvboxTheme);
tokyonightTheme.resolve = buildResolver(tokyonightTheme);

/**
 * All built-in themes.
 */
/**
 * Default theme name used when no theme is specified.
 */
export const DEFAULT_THEME = 'tokyonight';

export const THEMES: Record<string, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  'solarized-dark': solarizedDarkTheme,
  monokai: monokaiTheme,
  dracula: draculaTheme,
  catppuccin: catppuccinTheme,
  gruvbox: gruvboxTheme,
  tokyonight: tokyonightTheme,
};

let _currentTheme: Theme = darkTheme;

/**
 * Get a theme by name, falling back to 'dark'.
 */
export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES['dark']!;
}

/**
 * Switch to a theme by name at runtime.
 */
export function setTheme(name: string): Theme {
  const theme = THEMES[name];
  if (theme) _currentTheme = theme;
  return _currentTheme;
}

/**
 * Get the currently active runtime theme.
 */
export function getCurrentTheme(): Theme {
  return _currentTheme;
}

/**
 * Resolve a hex color string to a chalk function.
 */
export function resolveColor(hex: string): typeof chalk {
  return chalk.hex(hex);
}

/**
 * Get a themed chalk color by path (e.g., 'colors.primary').
 */
export function themeColor(theme: Theme, path: string): typeof chalk {
  const parts = path.split('.');
  let value: any = theme;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return chalk.white; // fallback
    }
  }

  if (typeof value === 'string') {
    return chalk.hex(value);
  }

  return chalk.white;
}

/**
 * List available theme names.
 */
export function listThemes(): string[] {
  return Object.keys(THEMES);
}
