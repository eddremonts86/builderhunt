import { useQuery } from '@tanstack/react-query'
import {
  DEFAULT_DASHBOARD_CONTEXT,
  dashboardContextSchema,
  type DashboardContext,
} from '~/shared/lib/dashboard-api'

/**
 * Reads `GET /api/dashboard/context` (plan: phase-2/04-dashboard-personalizado).
 *
 * ## It never fails to an unusable page
 *
 * Every failure — the request, a payload this build does not understand, a segment value from a
 * newer deploy — resolves to `DEFAULT_DASHBOARD_CONTEXT`, which is the `general` route with the
 * capabilities compiled into this build. A dashboard that could not render because a *preference*
 * did not load would be a worse product than one that renders the layout everybody already has.
 *
 * That is also why the payload is parsed rather than cast. A field the server added and this build
 * has not seen is not a reason to throw, but a `presetId` this build cannot resolve is: `.strict()`
 * catches it here, and the fallback answers `general` instead of indexing a record with a key it
 * does not have.
 *
 * ## Why it is separate from the overview query
 *
 * The overview is the page's data and re-fetches on a range change; the context is who the reader
 * is, and changes when they change their goal in settings. Folding one into the other would make
 * every range change re-read a preference, and would put the whole layout behind the slowest
 * projection on the page.
 */
export function useDashboardContext(): { context: DashboardContext; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['dashboard-context'],
    queryFn: async (): Promise<DashboardContext> => {
      const response = await fetch('/api/dashboard/context', { credentials: 'include' })
      if (!response.ok) return DEFAULT_DASHBOARD_CONTEXT
      const parsed = dashboardContextSchema.safeParse(await response.json())
      return parsed.success ? parsed.data : DEFAULT_DASHBOARD_CONTEXT
    },
    // The route somebody is on does not change while they read the page, and re-reading it on every
    // focus would put a preference lookup in front of a layout that is already correct.
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  return {
    context: query.data ?? DEFAULT_DASHBOARD_CONTEXT,
    isLoading: query.isLoading,
  }
}
