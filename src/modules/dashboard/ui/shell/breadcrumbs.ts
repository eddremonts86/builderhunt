import { breadcrumbFor } from './nav-config'

/**
 * Entity-aware breadcrumbs for detail routes (plans/UI/tasks.md Wave 1 "Add entity-aware
 * breadcrumbs and contextual parents"). `nav-config.ts`'s own `breadcrumbFor` only ever knows the
 * area + a level-2 item's declared label — it has no way to say "Acme Corp" instead of "Builder"
 * for `/builder/$builderId`, because it never sees loaded data. This module adds exactly that on
 * top, for the handful of routes that are reached by ID rather than by a nav destination.
 */

export interface BreadcrumbSegment {
  label: string
  /** Omitted on the final (current-page) segment — it renders as plain text, never a link to itself. */
  to?: string
}

interface ContextualRoute {
  /** Matches when the pathname starts with this. */
  prefix: string
  /** Exact pathnames under `prefix` that are NOT this entity type (a sibling static page, e.g. "new"). */
  exclude?: readonly string[]
  parentLabel: string
  parentTo: string
  /** Shown for the final crumb until (or unless) the route supplies a real loaded name. */
  fallbackLabel: string
}

const CONTEXTUAL_ROUTES: readonly ContextualRoute[] = [
  { prefix: '/builder/', parentLabel: 'Search', parentTo: '/search', fallbackLabel: 'Builder' },
  { prefix: '/lists/', parentLabel: 'Shortlists', parentTo: '/lists', fallbackLabel: 'Shortlist' },
  { prefix: '/sprints/', parentLabel: 'Sprints', parentTo: '/sprints', fallbackLabel: 'Sprint', exclude: ['/sprints/new'] },
  // `/interviews/invitations` is a static list page (plans/UI Wave 3 "Build a central invitation
  // management hub"), not a `$interviewId` detail route — excluded the same way `/sprints/new` is,
  // so it falls through to nav-config's own "Invitations" label instead of "Interview".
  { prefix: '/interviews/', parentLabel: 'Interviews', parentTo: '/interviews', fallbackLabel: 'Interview', exclude: ['/interviews/invitations'] },
]

function findContextualRoute(pathname: string): ContextualRoute | null {
  for (const route of CONTEXTUAL_ROUTES) {
    if (!pathname.startsWith(route.prefix)) continue
    if (route.exclude?.includes(pathname)) continue
    return route
  }
  return null
}

/**
 * `entityLabel` is the loaded entity's own display name (a builder's name, a shortlist's title,
 * …), or `null` while it hasn't loaded yet, failed to load, or the caller isn't on a route this
 * function recognizes as an entity detail page — in every `null` case the safe, generic
 * `fallbackLabel` is shown instead, never a blank crumb or the raw route id.
 */
export function resolveBreadcrumbSegments(
  pathname: string,
  isAdmin: boolean,
  entityLabel: string | null,
): BreadcrumbSegment[] {
  const contextual = findContextualRoute(pathname)
  if (!contextual) return breadcrumbFor(pathname, isAdmin).map((label) => ({ label }))
  return [
    { label: contextual.parentLabel, to: contextual.parentTo },
    { label: entityLabel ?? contextual.fallbackLabel },
  ]
}
