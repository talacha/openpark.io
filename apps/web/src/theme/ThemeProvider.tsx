import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'op.theme';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      const isDarkOS = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (stored === 'light') return 'light';
      if (stored === 'dark') return 'dark';
      return isDarkOS ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      const newResolvedTheme = theme === 'system' 
        ? (mediaQuery.matches ? 'dark' : 'light') 
        : theme;
      setResolvedTheme(newResolvedTheme);
      
      // Apply class synchronously to avoid flash
      if (newResolvedTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      }
    };

    // Initial update
    updateTheme();

    // Listen for system theme changes
    const handler = () => {
      if (theme === 'system') {
        updateTheme();
      }
    };
    mediaQuery.addEventListener('change', handler);

    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'light';
      return 'system';
    });
  }, []);

  // Value object
  const value = {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
