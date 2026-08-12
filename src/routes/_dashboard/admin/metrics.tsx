import { createFileRoute, redirect } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { AdminMetricsPage } from '~/modules/admin/metrics/AdminMetricsPage'
import { normalizeAdminMetricsSearch, searchNeedsRewrite } from '~/shared/lib/admin-metrics/url-state'

/**
 * `Route` is the only export here, deliberately.
 *
 * TanStack Router refuses to code-split a route file that exports anything else, and this page's component was
 * once exported from here so a unit test could import it — so ~780 lines of admin-only UI were bundled for
 * every visitor. It was the one route file in the codebase doing it. The component lives in
 * `~/modules/admin/metrics/AdminMetricsPage`, which the test imports instead.
 *
 * Adding an export to this file, however small and however convenient for a test, undoes that.
 */
export const Route = createFileRoute('/_dashboard/admin/metrics')({
  /**
   * Normalizes rather than refuses, which is the opposite of what `/api/admin/metrics/sections` does with the
   * same allowlists — and both are right for their caller. A URL is something a human edits, shortens, or
   * pastes from a stale bookmark, and a 400 on a metrics page during an incident is worse than the overview.
   * The API refuses because a defaulted section would return a payload that does not match what was asked for.
   */
  validateSearch: normalizeAdminMetricsSearch,
  beforeLoad: async ({ search, location }) => {
    await requirePlatformAdminPage()

    /**
     * The URL correction, here rather than in an effect — and that placement is the whole point.
     *
     * Falling back silently is its own failure: rendering the overview while the address bar still says
     * `traffic` means the operator shares that URL, the next person also gets the overview, and neither can
     * tell that the URL asked for something else. So it has to be rewritten.
     *
     * The first attempt did it in a `useEffect` that compared `useLocation().searchStr` against
     * `useSearch()`, and it broke navigation outright: during a router transition those two update at
     * different moments, so the effect saw the *new* raw string beside the *old* validated search, concluded
     * the URL needed correcting, and navigated back — every section click bounced straight to the section it
     * came from. `beforeLoad` runs once per navigation with both values already consistent, so there is no
     * pair to disagree.
     *
     * `location.searchStr` is the only place the pre-normalization values still exist; `search` has already
     * been through `validateSearch` by the time anything can read it.
     */
    const raw = Object.fromEntries(new URLSearchParams(location.searchStr))
    if (searchNeedsRewrite(raw, search)) {
      throw redirect({ to: '/admin/metrics', search, replace: true })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return <AdminMetricsPage {...Route.useSearch()} />
}
