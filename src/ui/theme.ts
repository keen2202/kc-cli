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

export interface Theme {
  name: string;
  colors: ThemeColors;
  syntax: ThemeSyntax;
  diff: ThemeDiff;
}

// Built-in themes

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
};

/**
 * All built-in themes.
 */
export const THEMES: Record<string, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  'solarized-dark': solarizedDarkTheme,
  monokai: monokaiTheme,
  dracula: draculaTheme,
};

/**
 * Get a theme by name, falling back to 'dark'.
 */
export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES['dark'];
}

/**
 * Resolve a hex color string to a chalk function.
 */
export function resolveColor(hex: string): chalk.Chalk {
  return chalk.hex(hex);
}

/**
 * Get a themed chalk color by path (e.g., 'colors.primary').
 */
export function themeColor(theme: Theme, path: string): chalk.Chalk {
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
