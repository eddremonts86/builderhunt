import { createFileRoute, redirect } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { DEFAULT_ADMIN_METRICS_SEARCH, landingRedirectTarget } from '~/shared/lib/admin-metrics/url-state'
import { getAdminLandingView } from '~/shared/lib/admin/preferences-session'

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
 * ## Authorization — same guard as every sibling
 *
 * Use `requirePlatformAdminPage` first: a non-admin is sent to `/dashboard` with a flash, instead
 * of being handed the raw "Something went wrong" error page (saas-review F5). The redirect to
 * `/admin/metrics` only runs after the guard has confirmed the caller is a platform admin. Stays
 * a `replace` so the URL does not become a back-button stop the admin has to click past.
 */
/**
 * ## Why the saved landing view is applied *here*
 *
 * This is the one URL that means "open the console" and carries no opinion about where. Every
 * `/admin/metrics?section=…` is somebody's explicit choice — a bookmark, or a link pasted into an
 * incident channel — and a personal default that overrode one of those would mean two admins
 * following the same link saw different pages while both address bars agreed. Applying the
 * preference at the index makes "an explicit URL wins" structural rather than a condition somebody
 * has to keep getting right.
 *
 * It was tried in `/admin/metrics`'s own `beforeLoad` first, gated on "the URL named nothing", and
 * that cannot work: TanStack Router serializes the *validated* search into `location` before
 * `beforeLoad` runs, so `location.searchStr` on a bare `/admin/metrics` already reads
 * `?section=overview&range=24h&variant=summary&compare=false` and `Object.keys(raw).length === 0` is
 * never true. Measured with `E2E_SERVER_LOG=1` rather than reasoned about, after the redirect
 * silently never fired.
 */
export const Route = createFileRoute('/_dashboard/admin/')({
  beforeLoad: async () => {
    await requirePlatformAdminPage()

    /**
     * The admin's saved view, or the default when there is none — and a failed read is the default too.
     *
     * `getAdminLandingView` answers `null` rather than throwing, because a preferences read must never keep an
     * administrator off the metrics page during an incident, which is exactly when the database it reads from may
     * be the thing that is broken.
     *
     * `landingRedirectTarget` returns `null` when the saved view is already the default, so the fallback below is
     * the same object either way — the branch exists to avoid re-deriving a value the helper already validated
     * against the live section and range vocabularies.
     */
    const target = landingRedirectTarget(await getAdminLandingView(), DEFAULT_ADMIN_METRICS_SEARCH)

    // `replace` so the URL does not become a back-button stop the admin has to
    // click past on their way out of the area.
    // The metrics route validates its search, so every link and redirect has to supply the whole state —
    // otherwise a redirect would silently reset a field. `DEFAULT_ADMIN_METRICS_SEARCH` is its one home.
    throw redirect({ to: '/admin/metrics', search: target ?? DEFAULT_ADMIN_METRICS_SEARCH, replace: true })
  },
})
