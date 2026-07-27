import * as React from 'react'
import type { BentoDensity } from './layout'

const STORAGE_KEY = 'bh.dashboard.density'

function isDensity(value: unknown): value is BentoDensity {
  return value === 'bento' || value === 'sections'
}

/**
 * The dashboard's display density, remembered per browser.
 *
 * `bento` is the default asymmetric grid; `sections` renders the same widgets as
 * a few full-width bubbles. Both read the same registry — the preference only
 * changes how `resolveBentoLayout` sizes what is already there.
 *
 * Starts at `bento` on the server and on the first client render, then adopts
 * the stored value in an effect: reading localStorage during render would make
 * the server and client markup disagree and cost a hydration mismatch.
 */
export function useBentoDensity(): [BentoDensity, (next: BentoDensity) => void] {
  const [density, setDensity] = React.useState<BentoDensity>('bento')

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (isDensity(stored)) setDensity(stored)
    } catch {
      // Private-mode Safari throws on localStorage access; the default stands.
    }
  }, [])

  const update = React.useCallback((next: BentoDensity) => {
    setDensity(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Preference is best-effort — never block the layout change on storage.
    }
  }, [])

  return [density, update]
}
