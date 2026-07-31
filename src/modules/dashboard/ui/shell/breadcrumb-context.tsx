import * as React from 'react'

/**
 * Lets a leaf route component (loaded deep inside `<main>`) hand its entity's display name up to
 * `DashboardLayout`'s topbar breadcrumb, without every route threading a prop through the shell.
 * The shell renders a safe parent + generic label immediately; a route calls
 * `useEntityBreadcrumbLabel` once its own data loads, which swaps in the real name.
 */

interface BreadcrumbContextValue {
  entityLabel: string | null
  setEntityLabel: (label: string | null) => void
}

// A no-op default (not `null`) rather than a "must be inside a provider" throw: some leaf
// components (e.g. `BuilderProfilePage`) render under both the dashboard shell AND a plain public
// route with no `BreadcrumbProvider` ancestor (`/builders/$builderId`) — calling the write hook
// there must do nothing, not crash a public page over a dashboard-only affordance.
const noopContextValue: BreadcrumbContextValue = { entityLabel: null, setEntityLabel: () => {} }
const BreadcrumbContext = React.createContext<BreadcrumbContextValue>(noopContextValue)

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [entityLabel, setEntityLabel] = React.useState<string | null>(null)
  const value = React.useMemo(() => ({ entityLabel, setEntityLabel }), [entityLabel])
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>
}

function useBreadcrumbContext(): BreadcrumbContextValue {
  return React.useContext(BreadcrumbContext)
}

/** Read-only — `DashboardLayout` itself is the only writer-facing consumer via `setEntityLabel`. */
export function useCurrentEntityBreadcrumbLabel(): string | null {
  return useBreadcrumbContext().entityLabel
}

/**
 * Call from a leaf route component with the loaded entity's display name (or `null` while
 * loading/on error, which keeps the shell's safe fallback label visible). Clears on unmount so
 * navigating to an unrelated route never leaves a stale name in the breadcrumb.
 */
export function useEntityBreadcrumbLabel(label: string | null): void {
  const { setEntityLabel } = useBreadcrumbContext()
  React.useEffect(() => {
    setEntityLabel(label)
    return () => setEntityLabel(null)
  }, [label, setEntityLabel])
}
