import * as React from 'react'

export type Theme = 'dark' | 'light'
export type Accent = 'brand' | 'neon'

const THEME_KEY = 'bh-theme'
const ACCENT_KEY = 'bh-accent'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

function readStored<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  if (typeof window === 'undefined') return fallback
  const stored = window.localStorage.getItem(key)
  return (valid as readonly string[]).includes(stored ?? '') ? (stored as T) : fallback
}

/**
 * Mounted only inside DashboardLayout (not the app root), but the `.dark`/`.accent-neon`
 * classes it manages are synced onto `<html>` for as long as this provider is mounted —
 * not onto its own subtree. Floating UI (menus, dialogs) portals to `document.body`,
 * which sits as a *sibling* of the dashboard shell's own wrapper div, not a descendant —
 * a class scoped to that wrapper div is invisible to anything portaled out of it. Syncing
 * to `<html>` on mount and removing it on unmount keeps portaled dashboard UI themed
 * correctly while still leaving public/landing routes untouched, since this provider
 * (and therefore the effect) only exists while a `_dashboard` route is mounted.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => readStored(THEME_KEY, 'dark', ['dark', 'light']))
  const [accent, setAccentState] = React.useState<Accent>(() => readStored(ACCENT_KEY, 'brand', ['brand', 'neon']))

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next)
    window.localStorage.setItem(THEME_KEY, next)
  }, [])

  const setAccent = React.useCallback((next: Accent) => {
    setAccentState(next)
    window.localStorage.setItem(ACCENT_KEY, next)
  }, [])

  React.useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('accent-neon', accent === 'neon')
    return () => {
      root.classList.remove('dark', 'accent-neon')
    }
  }, [theme, accent])

  const value = React.useMemo(
    () => ({ theme, setTheme, accent, setAccent }),
    [theme, setTheme, accent, setAccent],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
