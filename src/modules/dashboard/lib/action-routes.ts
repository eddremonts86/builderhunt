import type { DashboardAction, DashboardActionKind } from '~/shared/lib/dashboard/contracts'

/**
 * Turns an allowlisted action kind into a destination this app owns
 * (plans/ui-dashboard Wave 2, "Build the Action Queue widget" — "Resolve only allowlisted route
 * kinds; render unknown kinds safely as unavailable").
 *
 * ## Why the server does not just send a link
 *
 * Because then the server would be choosing where a click goes, and this projection assembles its
 * rows from tenant data. A `href` that reaches an anchor is an open redirect waiting for one
 * repository to select the wrong column; the contract's id pattern already refuses anything
 * path-shaped, and this map is the other half — even a valid-looking string can only ever be
 * substituted into a path *this file* wrote.
 *
 * ## Unknown kinds resolve to null, deliberately
 *
 * A server can learn a new action kind before the deployed client can render it. The honest response
 * is no button, not a guess: a control that navigates somewhere plausible is worse than an absent
 * one, because the user believes they dealt with the thing.
 */

/** Label for the single primary action, so every row's verb comes from one place. */
const ACTION_LABELS: Record<DashboardActionKind, string> = {
  'open-billing': 'Open billing',
  'open-interview': 'Open interview',
  'open-calendar': 'Open calendar',
  'open-availability': 'Set availability',
  'open-invitation': 'Open invitation',
  'open-membership-invitation': 'Review invitation',
  'open-alert': 'Open alerts',
  'open-sprint': 'Open sprint',
  'open-saved-search': 'Open search',
  'open-builder': 'Open profile',
  'open-team': 'Open team',
  'open-onboarding': 'Finish setup',
  'open-search': 'Start a hunt',
}

/**
 * Resolves an action to a path.
 *
 * `resourceId` is interpolated only where the route genuinely takes one, and only after the contract
 * has already constrained it to `[A-Za-z0-9_-]{1,64}`. A kind whose route needs an id but was sent
 * none resolves to `null` rather than to the collection page: sending someone to a list when they
 * expected a specific thing is a quieter failure than no link, and quieter is worse here.
 */
export function resolveActionHref(action: DashboardAction): string | null {
  const { kind, resourceId } = action
  switch (kind) {
    case 'open-billing': return '/settings/billing'
    case 'open-team': return '/settings/team'
    case 'open-onboarding': return '/onboarding/welcome'
    case 'open-search': return '/search'
    case 'open-alert': return '/alerts'
    case 'open-calendar': return '/calendar'
    /*
     * `/calendar` and not `/calendar/availability`: the availability editor lives inside the calendar
     * page rather than at its own route. Pointing at a path that does not exist would produce a 404
     * from a queue item whose whole purpose is to unblock someone.
     */
    case 'open-availability': return '/calendar'
    case 'open-sprint': return resourceId ? `/sprints/${resourceId}` : null
    case 'open-interview': return resourceId ? `/interviews/${resourceId}` : null
    // The invitation hub is one page; individual invitations are rows on it, not routes.
    case 'open-invitation': return '/interviews/invitations'
    /*
     * A membership invitation *is* its own route, and it needs the id. `null` without one rather than
     * a fallback to a list: there is no "all my team invitations" page, and inventing a destination
     * for a queue row whose job is to unblock someone is worse than showing no link.
     */
    case 'open-membership-invitation': return resourceId ? `/team/invite/${resourceId}` : null
    /*
     * `/search`, without the saved-search id. The saved search is loaded through a query parameter,
     * and a path built here would either encode one this router does not read or invent a route that
     * does not exist. No rule emits this kind yet; when one does, it wants
     * `<Link to="/search" search={{ saved: id }}>` and its own entry, not a string with a `?` in it.
     */
    case 'open-saved-search': return '/search'
    case 'open-builder': return resourceId ? `/builder/${resourceId}` : null
    default: {
      // Exhaustiveness: adding a kind to the contract without a route here is a type error, not a
      // dead button discovered in production.
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

export function actionLabel(kind: DashboardActionKind): string {
  return ACTION_LABELS[kind] ?? 'Open'
}
