import { createFileRoute, redirect } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { ClaimsPage } from '~/modules/admin/claims/ClaimsPage'
import { CLAIM_STATUS_FILTERS } from '~/modules/admin/claims/ClaimsPage'
import { statusFilterValidator, statusNeedsRewrite } from '~/shared/lib/admin/status-filter'

/**
 * The status filter lives in the URL, not in `useState` (plan 57, Admin track).
 *
 * An operator narrowing claims to `pending` and pasting the URL into an incident channel used to send everyone
 * else the unfiltered list — which is worse than useless, because the reader believes they are looking at what
 * was described. Reload lost it too, and Back was not connected to either click.
 *
 * `beforeLoad` rewrites the URL when normalization changed something, rather than a `useEffect` doing it:
 * during a router transition `useLocation()` and `useSearch()` update at different moments, so an effect
 * comparing them sees a mismatched pair and navigates back — which on the metrics page broke every filter click
 * until it moved here.
 */
const validateSearch = statusFilterValidator(
  CLAIM_STATUS_FILTERS.filter((option) => option.value !== 'all').map((option) => option.value),
  'all',
)

export const Route = createFileRoute('/_dashboard/admin/claims')({
  validateSearch,
  beforeLoad: async ({ search, location }) => {
    await requirePlatformAdminPage()
    const raw = Object.fromEntries(new URLSearchParams(location.searchStr))
    if (statusNeedsRewrite(raw, search)) {
      throw redirect({ to: '/admin/claims', search, replace: true })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return <ClaimsPage status={Route.useSearch().status} />
}
