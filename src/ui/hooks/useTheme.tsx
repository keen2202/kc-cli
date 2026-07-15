import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';
import {
  getTheme,
  setTheme as setGlobalTheme,
  DEFAULT_THEME,
  type Theme,
  type ThemeTokens,
} from '../theme';

interface ThemeContextValue {
  theme: Theme;
  tokens: ThemeTokens;
  setTheme: (name: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, initialTheme }: { children: ReactNode; initialTheme?: string }) {
  const [theme, setThemeState] = useState<Theme>(() => getTheme(initialTheme || DEFAULT_THEME));

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    tokens: theme.resolve(),
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
