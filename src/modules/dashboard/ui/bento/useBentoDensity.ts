import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import type { BentoDensity } from './layout'

/**
 * The user's dashboard layout, stored per (organization, user) on the server
 * (plans/ui-dashboard Wave 6, and structural problem 10: "Local preferences are fragile").
 *
 * ## What this replaces
 *
 * A single `localStorage` key. Two things were wrong with it, and the second is the one that
 * mattered: it was per *browser*, so the same person got a different dashboard on their laptop and
 * their phone and lost both when they cleared site data; and it was keyed by nothing, so switching
 * organizations carried one workspace's layout into another — hide a widget in a personal workspace
 * and it stayed hidden in the team's, where a different person's decisions apply.
 *
 * The hydration concern the old comment described is gone with the storage: the value now arrives
 * from a query, so the first client render and the server render agree on the default and the real
 * preference lands with the response.
 *
 * ## Optimistic, because a layout toggle must feel instant
 *
 * The control updates the cache before the request and rolls back if it fails. A density toggle that
 * waits for a round trip feels broken at 200 ms, and there is nothing to reconcile: the write is a
 * whole-document replace, so "last change wins" is the only merge rule a layout preference has.
 *
 * ## Failures are silent, deliberately
 *
 * A failed read yields the defaults; a failed write rolls the toggle back and says nothing. Neither
 * deserves a message: the user can see whether the layout changed, and a toast about a preference is
 * noise on a page whose job is to surface real problems.
 */

export interface DashboardLayoutPreferences {
  density: BentoDensity
  hiddenWidgetIds: readonly string[]
}

const DEFAULTS: DashboardLayoutPreferences = { density: 'bento', hiddenWidgetIds: [] }

function isDensity(value: unknown): value is BentoDensity {
  return value === 'bento' || value === 'sections'
}

export interface UseDashboardPreferences {
  preferences: DashboardLayoutPreferences
  setDensity: (next: BentoDensity) => void
  /** Adds or removes a widget id. Critical widgets ignore the list — see `orderedWidgets`. */
  toggleHidden: (widgetId: string) => void
}

export function useDashboardPreferences(): UseDashboardPreferences {
  const organizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()
  // Scoped by organization, which is the whole point: the same person's layout in two workspaces is
  // two different preferences. `TenantQueryProvider` also clears the client on a switch.
  const queryKey = organizationQueryKey(organizationId, 'dashboard-preferences')

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<DashboardLayoutPreferences> => {
      const response = await fetch('/api/dashboard/preferences', { credentials: 'include' })
      if (!response.ok) return DEFAULTS
      const body = await response.json() as { density?: unknown; hiddenWidgetIds?: unknown }
      return {
        density: isDensity(body.density) ? body.density : 'bento',
        hiddenWidgetIds: Array.isArray(body.hiddenWidgetIds)
          ? body.hiddenWidgetIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    },
    retry: false,
  })

  const preferences = query.data ?? DEFAULTS

  const mutation = useMutation({
    mutationFn: async (next: DashboardLayoutPreferences) => {
      const response = await fetch('/api/dashboard/preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ density: next.density, hiddenWidgetIds: [...next.hiddenWidgetIds] }),
      })
      if (!response.ok) throw new Error(`preferences: ${response.status}`)
    },
    onMutate: async (next) => {
      // Cancel first: an in-flight read landing after this write would overwrite the optimistic value
      // with the pre-change server state, and the toggle would visibly snap back.
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<DashboardLayoutPreferences>(queryKey)
      queryClient.setQueryData(queryKey, next)
      return { previous }
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
    },
  })

  const setDensity = React.useCallback((density: BentoDensity) => {
    mutation.mutate({ ...preferences, density })
  }, [mutation, preferences])

  const toggleHidden = React.useCallback((widgetId: string) => {
    const hidden = new Set(preferences.hiddenWidgetIds)
    if (hidden.has(widgetId)) hidden.delete(widgetId)
    else hidden.add(widgetId)
    mutation.mutate({ ...preferences, hiddenWidgetIds: [...hidden] })
  }, [mutation, preferences])

  return { preferences, setDensity, toggleHidden }
}

/**
 * The density toggle's existing signature, unchanged.
 *
 * Kept as a shim so moving the storage is one concern rather than two: `DensityToggle`'s markup and
 * its tests are untouched, and only where the value lives changed.
 */
export function useBentoDensity(): [BentoDensity, (next: BentoDensity) => void] {
  const { preferences, setDensity } = useDashboardPreferences()
  return [preferences.density, setDensity]
}
