import { createFileRoute, redirect } from '@tanstack/react-router'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'

/**
 * `/admin` — the index the Admin area never had.
 *
 * ## The gap
 *
 * `nav-config.ts` registers the Admin area with `routes: ['/admin']`, which is what makes the rail
 * highlight it and what every breadcrumb resolves against. There was no route at that path, so the
 * bare URL answered **404**: an administrator who clicked the area icon, edited the address bar, or
 * followed a stale link landed on a not-found page inside an area they own. Verified before this
 * file existed.
 *
 * ## Why this is a redirect and not a Command Center
 *
 * `plans/ui-dashboard` specifies a platform-admin Command Center at `/admin` — a landing page
 * summarising attention across Incidents, Billing ops, Abuse, Refunds, Disputes and the rest. The
 * maintainer's ruling on 2026-08-06 was **"índice = metrics"**: the index *is* the Metrics page, not
 * a new destination beside it.
 *
 * That is the smaller and better answer, and not only because it is less work. A summary page whose
 * every tile links to a real page it summarises has to be maintained in step with all of them, and
 * the first thing to rot is the one nobody opens — this repository already has the evidence, in an
 * `/admin/integrations` projection that showed two retired sources as ACTIVE because it was built
 * from a compile-time registry nobody updated. Metrics is a page operators already read. The
 * Command Center's attention summary belongs *on* it, where a stale number is noticed.
 *
 * ## Authorization is duplicated on purpose
 *
 * The same `getIsAppAdmin` check runs here and again on `/admin/metrics`. Redirecting an
 * unauthorized caller to a page that will refuse them would answer "there is something here" before
 * refusing, and a redirect is a cheaper oracle to probe than a page. The refusal happens first.
 */
export const Route = createFileRoute('/_dashboard/admin/')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    // `replace` so the 404-shaped URL does not become a back-button stop the administrator has to
    // click past on their way out of the area.
    throw redirect({ to: '/admin/metrics', replace: true })
  },
})
