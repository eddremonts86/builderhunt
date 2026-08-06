import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import {
  DEFAULT_PREFERENCES_DOCUMENT,
  dashboardPreferencesDocumentSchema,
  type DashboardPreferencesDocument,
} from '~/shared/lib/dashboard/preferences-contract'
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
 * ## Optimistic, because a layout change must feel instant
 *
 * The control updates the cache before the request and rolls back if it fails. A density toggle that
 * waits for a round trip feels broken at 200 ms.
 *
 * ## What a 409 means, and why it is not a rollback
 *
 * The write carries the revision it read. When another tab got there first the server refuses and
 * returns the document that won, and this hook **adopts** it rather than restoring the pre-mutation
 * value. Rolling back would show an arrangement that is now wrong in a third way — neither what this
 * tab tried nor what is stored. The user's change is lost either way; showing them the truth costs
 * nothing extra and leaves the next press working against a revision that exists.
 *
 * ## Other failures are silent, deliberately
 *
 * A failed read yields the defaults; a failed write rolls the change back and says nothing. Neither
 * deserves a message: the user can see whether the layout changed, and a toast about a preference is
 * noise on a page whose job is to surface real problems.
 */

export type DashboardLayoutPreferences = DashboardPreferencesDocument

const DEFAULTS = DEFAULT_PREFERENCES_DOCUMENT

/** Thrown by the mutation so `onError` can tell "somebody else saved" from "the request failed". */
class PreferencesConflictError extends Error {
  constructor(readonly current: DashboardLayoutPreferences) {
    super('preferences: 409')
    this.name = 'PreferencesConflictError'
  }
}

export interface UseDashboardPreferences {
  preferences: DashboardLayoutPreferences
  setDensity: (next: BentoDensity) => void
  /** Adds or removes a widget id. Critical widgets ignore the list — see `orderedWidgets`. */
  toggleHidden: (widgetId: string) => void
  /** Pins or unpins. A pinned widget leads the sequence, after any critical one. */
  togglePinned: (widgetId: string) => void
  /** Replaces the whole sequence. Callers compute it with `moveWidgetInOrder`. */
  setOrder: (widgetIds: readonly string[]) => void
  /**
   * Back to the defaults.
   *
   * A write of the default document, not a delete: the row's absence and the row holding the
   * defaults mean the same thing to every reader, and there is no DELETE grant on the table
   * precisely because nothing needs one.
   */
  resetPreferences: () => void
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
      // Parsed, not trusted: a shape this build does not understand becomes the default layout rather
      // than a page that renders half an arrangement.
      const parsed = dashboardPreferencesDocumentSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : DEFAULTS
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
        body: JSON.stringify({
          revision: next.revision,
          density: next.density,
          hiddenWidgetIds: [...next.hiddenWidgetIds],
          pinnedWidgetIds: [...next.pinnedWidgetIds],
          orderedWidgetIds: [...next.orderedWidgetIds],
        }),
      })
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as { current?: unknown } | null
        const current = dashboardPreferencesDocumentSchema.safeParse(body?.current)
        throw new PreferencesConflictError(current.success ? current.data : DEFAULTS)
      }
      if (!response.ok) throw new Error(`preferences: ${response.status}`)
      const saved = dashboardPreferencesDocumentSchema.safeParse(await response.json().catch(() => null))
      return saved.success ? saved.data : { ...next, revision: next.revision + 1 }
    },
    onMutate: async (next) => {
      // Cancel first: an in-flight read landing after this write would overwrite the optimistic value
      // with the pre-change server state, and the control would visibly snap back.
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<DashboardLayoutPreferences>(queryKey)
      queryClient.setQueryData(queryKey, next)
      return { previous }
    },
    onError: (error, _next, context) => {
      if (error instanceof PreferencesConflictError) {
        queryClient.setQueryData(queryKey, error.current)
        return
      }
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
    },
    onSuccess: (saved) => {
      // The revision the server assigned. Without this the next change would re-send the revision we
      // read at load and be refused — the tab would conflict with its own previous write.
      queryClient.setQueryData(queryKey, saved)
    },
  })

  /*
   * Every mutator reads the cache rather than closing over `preferences`.
   *
   * Two rapid presses — a move, then another before the response — would otherwise both build on the
   * render's snapshot, and the second would silently undo the first. `onMutate` has already written
   * the optimistic value here, so a burst composes. (A ref updated during render would do the same
   * job and is a rules-of-react violation; the cache is the actual source of truth anyway.)
   */
  const current = React.useCallback(
    () => queryClient.getQueryData<DashboardLayoutPreferences>(queryKey) ?? DEFAULTS,
    [queryClient, queryKey],
  )

  const save = React.useCallback((change: Partial<DashboardLayoutPreferences>) => {
    mutation.mutate({ ...current(), ...change })
  }, [mutation, current])

  const setDensity = React.useCallback((density: BentoDensity) => {
    save({ density })
  }, [save])

  const toggleHidden = React.useCallback((widgetId: string) => {
    const hidden = new Set(current().hiddenWidgetIds)
    if (hidden.has(widgetId)) hidden.delete(widgetId)
    else hidden.add(widgetId)
    save({ hiddenWidgetIds: [...hidden] })
  }, [save, current])

  const togglePinned = React.useCallback((widgetId: string) => {
    const pinned = current().pinnedWidgetIds
    save({
      pinnedWidgetIds: pinned.includes(widgetId)
        ? pinned.filter((id) => id !== widgetId)
        // Appended, not prepended: pins are shown in the order they were made, and a new pin that
        // displaced the previous one would move a widget the user did not touch.
        : [...pinned, widgetId],
    })
  }, [save, current])

  const setOrder = React.useCallback((widgetIds: readonly string[]) => {
    save({ orderedWidgetIds: [...widgetIds] })
  }, [save])

  const resetPreferences = React.useCallback(() => {
    // The defaults at the *current* revision — a reset is a write like any other, and sending
    // revision 0 would be refused by every user who has ever saved.
    save({ ...DEFAULTS, revision: current().revision })
  }, [save, current])

  return { preferences, setDensity, toggleHidden, togglePinned, setOrder, resetPreferences }
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
