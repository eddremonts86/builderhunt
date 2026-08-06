import { createFileRoute } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { AdminMetricsPage } from '~/modules/admin/metrics/AdminMetricsPage'

/**
 * `Route` is the only export here, deliberately.
 *
 * TanStack Router refuses to code-split a route file that exports anything else, and this page's
 * component was exported from here so a unit test could import it — so ~780 lines of admin-only UI
 * were bundled for every visitor. It was the one route file in the codebase doing it. The component
 * now lives in `~/modules/admin/metrics/AdminMetricsPage`, which the test imports instead.
 *
 * Adding an export to this file, however small and however convenient for a test, undoes that.
 */
export const Route = createFileRoute('/_dashboard/admin/metrics')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminMetricsPage,
})
