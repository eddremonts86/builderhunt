import * as React from 'react'

export type Theme = 'dark' | 'light'

const THEME_KEY = 'bh-theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

function readStored<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  if (typeof window === 'undefined') return fallback
  const stored = window.localStorage.getItem(key)
  return (valid as readonly string[]).includes(stored ?? '') ? (stored as T) : fallback
}

/**
 * Mounted per top-level layout (dashboard, onboarding, public/landing) rather than once at
 * the app root, but the `.dark` class it manages is synced onto `<html>` for as long as a
 * given instance is mounted — not onto its own subtree. Floating UI (menus, dialogs) portals
 * to `document.body`, which sits as a *sibling* of any wrapper div, not a descendant — a class
 * scoped to that wrapper div is invisible to anything portaled out of it. Syncing to `<html>`
 * on mount and removing it on unmount keeps portaled UI themed correctly no matter which
 * layout is currently mounted. Since the three layouts are mutually exclusive per route, only
 * one instance is ever mounted at a time, and all instances share the same localStorage key,
 * so the theme choice persists seamlessly across them.
 *
 * State starts from the SSR-safe default ('dark') rather than reading localStorage in the
 * initializer: the server has no `window`, so an SSR render always produces that default, and
 * reading the real value in the client's lazy initializer would make the client's very first
 * (hydration) render disagree with the server-rendered attributes — React detects that as a
 * hydration mismatch and, per its own warning, "won't patch it up" (the mismatched attributes
 * are left as the server rendered them, e.g. the ThemeToggle's `aria-checked` staying stuck on
 * the wrong button). Re-reading the stored value in a post-mount effect instead is a normal
 * client-side re-render, which React reconciles and applies correctly.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('dark')

  React.useEffect(() => {
    setThemeState(readStored<Theme>(THEME_KEY, 'dark', ['dark', 'light']))
  }, [])

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next)
    window.localStorage.setItem(THEME_KEY, next)
  }, [])

  React.useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    return () => {
      root.classList.remove('dark')
    }
  }, [theme])

  const value = React.useMemo(
    () => ({ theme, setTheme }),
    [theme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
