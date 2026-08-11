import { createFileRoute, redirect } from '@tanstack/react-router'
import { requirePlatformAdminPage } from '~/shared/lib/auth/auth-session'
import { AccessRequestsPage, ACCESS_STATUS_FILTERS } from '~/modules/admin/access-requests/AccessRequestsPage'
import { statusFilterValidator, statusNeedsRewrite } from '~/shared/lib/admin/status-filter'

/**
 * Where invite-only sign-up is administered (waitlist-launch plan).
 *
 * The `beforeLoad` guard mirrors every other admin route: it keeps a non-admin from *rendering* the page. It is
 * not the security boundary — `/api/admin/access-requests` re-checks the principal on every call, and the
 * database refuses an UPDATE from any role but `builderhunt_platform`. Three layers, because the middle one is
 * the only one an attacker cannot skip by calling the API directly.
 *
 * The status filter is in the URL (plan 57, Admin track). It defaults to `pending`, which makes the sharing
 * problem sharper here than elsewhere: an operator who widened the list to `all` and pasted the URL used to send
 * everyone else back to the pending queue, so the reader saw fewer rows than the person describing them.
 */
const validateSearch = statusFilterValidator(
  ACCESS_STATUS_FILTERS.filter((option) => option.value !== 'all').map((option) => option.value),
  'pending',
)

export const Route = createFileRoute('/_dashboard/admin/access-requests')({
  validateSearch,
  beforeLoad: async ({ search, location }) => {
    await requirePlatformAdminPage()
    const raw = Object.fromEntries(new URLSearchParams(location.searchStr))
    if (statusNeedsRewrite(raw, search)) {
      throw redirect({ to: '/admin/access-requests', search, replace: true })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return <AccessRequestsPage status={Route.useSearch().status} />
}
