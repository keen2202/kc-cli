import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';
import {
  getTheme,
  setTheme as setGlobalTheme,
  DEFAULT_THEME,
  type Theme,
  type ThemeTokens,
  type ThemeColors,
} from '../theme';

interface ThemeContextValue {
  theme: Theme;
  tokens: ThemeTokens;
  /**
   * Raw hex color palette for the active theme. Use these for ink props that
   * require string colors (`<Text color>`, `<Box borderColor>`), since
   * `tokens` are chalk functions unsuitable for those props.
   */
  colors: ThemeColors;
  setTheme: (name: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, initialTheme }: { children: ReactNode; initialTheme?: string }) {
  const [theme, setThemeState] = useState<Theme>(() => getTheme(initialTheme || DEFAULT_THEME));

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    tokens: theme.resolve(),
    colors: theme.colors,
    setTheme: (name: string) => {
      const next = setGlobalTheme(name);
      setThemeState(next);
    },
  }), [theme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
