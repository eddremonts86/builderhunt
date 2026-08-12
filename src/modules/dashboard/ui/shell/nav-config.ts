/**
 * The dashboard's navigation, as data.
 *
 * Shell C is two levels: a 60px rail of *areas* and a 212px panel listing the
 * destinations inside the active area. Both levels — plus the topbar's
 * breadcrumb — are derived from this one array, so adding a destination is
 * appending an entry, never editing three components.
 *
 * Why two levels: `/admin` alone owns 10 destinations and keeps growing. In the
 * old single-row topbar they lived behind an avatar dropdown together with the
 * 5 workspace settings pages, which is 16 of 23 destinations hidden. Here admin
 * gets its own column and its own subgroups.
 */

import {
  Activity, AlertTriangle, BadgeCheck, BookOpen, CalendarDays, CircleUser, Cog, Compass, CreditCard,
  DoorOpen,
  Download, Gauge, Globe, History, Inbox, Layers, LayoutDashboard, Lightbulb, ListChecks, Mail, Map, Plug, Plus, RotateCcw,
  Mic, Send,
  Search, Shield, ShieldAlert, ShieldCheck, Siren, Users, FlaskConical,
} from 'lucide-react'

import type { FileRouteTypes } from '~/routeTree.gen'

type IconComponent = React.ComponentType<{ className?: string }>

export interface NavItem {
  to: string
  label: string
  icon: IconComponent
  /** Optional group heading rendered above this item in the level-2 panel. */
  group?: string
  /** Which live counter feeds this item's badge, if any. */
  badge?: 'unreadAlerts'
  /**
   * Exact-match activation. Needed for an item whose path prefixes a sibling's
   * (`/settings/billing` vs `/settings/billing/return`) and for area landing
   * pages that must not stay lit while a child route is open.
   */
  exact?: boolean
}

export interface NavArea {
  id: string
  label: string
  icon: IconComponent
  /**
   * Route prefixes owned by this area, longest-first at resolution time. An
   * area is active when the current path starts with any of them, which is what
   * makes a deep link like `/sprints/abc/candidates` light the right rail icon.
   */
  routes: readonly string[]
  items: readonly NavItem[]
  /** Platform-admin only — the rail icon is omitted for everyone else. */
  adminOnly?: boolean
  /** Pinned to the bottom of the rail, above nothing else. */
  footer?: boolean
}

/**
 * Every `/admin/*` route that exists, as a type.
 *
 * `FileRouteTypes['fullPaths']` is generated from the route files, so this union *is* the set of admin pages on
 * disk. Extracting it here is what makes `ADMIN_DESTINATIONS` below a single authoritative registry rather than a
 * second list that happens to agree: TypeScript requires an entry for every admin route and rejects an entry for
 * a path that is not one.
 *
 * `import type` on purpose — the generated module imports every route, and every route imports its page, so a
 * value import here would be a cycle. A type import is erased.
 *
 * `'/admin/'` is excluded explicitly, and the first version of this got it wrong: `/admin/${string}` matches the
 * index's own full path, because `${string}` can be empty — so the compiler asked for a nav entry for the
 * redirect. That is the type doing its job. `/admin` resolves to `/admin/metrics` and has no destination of its
 * own, and the exclusion states that rather than a comment claiming it.
 */
type AdminFullPath = Exclude<Extract<FileRouteTypes['fullPaths'], `/admin/${string}`>, '/admin/'>

/**
 * The one authoritative Admin route registry (plan 57, Admin track — "Reconcile stale and future Admin
 * destinations").
 *
 * ## What this replaces, and why a gate was not enough
 *
 * `nav-config.ts` and the route files were two lists that agreed, kept agreeing by
 * `scripts/check-ui-route-graph.mjs` — which catches both directions and runs in `ci:local`. That gate is still
 * worth having for the *reverse* case it also covers, but it is a check that runs after the fact. Typing the
 * registry as `Record<AdminFullPath, …>` moves the same guarantee to compile time: adding
 * `src/routes/_dashboard/admin/foo.tsx` breaks the build until somebody decides what it is called and where it
 * belongs, which is the decision the gate could only remind you to make later.
 *
 * ## Why the routes are the source of truth and not this file
 *
 * A route file is the page's existence; a label and an icon are how it is presented. Existence cannot be
 * declared in two places, and presentation cannot be derived from a filename — `solutions-gold-set` is "Gold
 * set" and `abuse` is "Abuse console". So the union comes from disk and the rest is written down once.
 *
 */
const ADMIN_DESTINATIONS: Record<AdminFullPath, Omit<NavItem, 'to'>> = {
  '/admin/metrics': { label: 'Metrics', icon: Activity, group: 'Operations' },
  '/admin/operations': { label: 'Operations', icon: Cog, group: 'Operations' },
  '/admin/integrations': { label: 'Integrations', icon: Plug, group: 'Operations' },
  '/admin/sources': { label: 'Sources', icon: Globe, group: 'Operations' },
  // Registered rather than reachable only by URL: an admin page nobody can navigate to is a page nobody uses,
  // and the gold set only produces value when a curator actually writes judgments into it.
  '/admin/solutions-gold-set': { label: 'Gold set', icon: FlaskConical, group: 'Operations' },
  '/admin/users': { label: 'Users', icon: Users, group: 'Operations' },
  '/admin/incidents': { label: 'Incidents', icon: AlertTriangle, group: 'Operations' },
  '/admin/claims': { label: 'Claims', icon: BadgeCheck, group: 'Operations' },
  '/admin/access-requests': { label: 'Access requests', icon: DoorOpen, group: 'Operations' },
  '/admin/abuse': { label: 'Abuse console', icon: Siren, group: 'Operations' },
  '/admin/billing': { label: 'Billing ops', icon: Gauge, group: 'Money' },
  '/admin/refunds': { label: 'Refunds', icon: RotateCcw, group: 'Money' },
  '/admin/disputes': { label: 'Disputes', icon: ShieldAlert, group: 'Money' },
  // Content is the hub over all three public surfaces; Changelog and Roadmap stay listed because they are the
  // two people navigate to directly, and both render the same components the hub's tabs do.
  '/admin/content': { label: 'Content', icon: Layers, group: 'Public', exact: true },
  '/admin/changelog': { label: 'Changelog', icon: BookOpen, group: 'Public' },
  '/admin/roadmap': { label: 'Roadmap', icon: Map, group: 'Public' },
}

/**
 * Grouped in declaration order, which is the order the panel renders.
 *
 * Derived rather than written out a second time — the whole point of the registry above. `Object.entries` keeps
 * insertion order for string keys, so "Operations before Money before Public" is the order in the literal.
 */
const ADMIN_NAV_ITEMS: readonly NavItem[] = Object.entries(ADMIN_DESTINATIONS).map(([to, item]) => ({ to, ...item }))

export const NAV_AREAS: readonly NavArea[] = [
  // Every `to` below is a route that exists in src/routes — the level-2 panel
  // is not a place to advertise pages we haven't built. `/dashboard` owns a
  // single destination today, so it borrows shortcuts to the surfaces people
  // jump to from the overview; duplicating a `to` across areas is fine and
  // already happens with Exports.
  {
    id: 'home',
    label: 'Home',
    icon: LayoutDashboard,
    routes: ['/dashboard'],
    items: [
      { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, group: 'View', exact: true },
      { to: '/search', label: 'Search builders', icon: Search, group: 'Shortcuts' },
      { to: '/sprints', label: 'Sprints', icon: Compass, group: 'Shortcuts', exact: true },
      { to: '/alerts', label: 'Inbox', icon: Mail, group: 'Shortcuts', badge: 'unreadAlerts' },
    ],
  },
  {
    id: 'discover',
    label: 'Discover',
    icon: Search,
    routes: ['/search', '/solutions', '/builder'],
    items: [
      { to: '/search', label: 'Search', icon: Search, group: 'Discover' },
      { to: '/solutions', label: 'Solutions', icon: Lightbulb, group: 'Discover' },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    icon: Compass,
    routes: ['/sprints', '/calendar', '/interviews', '/lists'],
    items: [
      { to: '/sprints', label: 'Sprints', icon: Compass, group: 'Pipeline', exact: true },
      { to: '/sprints/new', label: 'New sprint', icon: Plus, group: 'Pipeline' },
      { to: '/lists', label: 'Shortlists', icon: ListChecks, group: 'Pipeline' },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays, group: 'Schedule' },
      // Owned by Pipeline because that is where the calendar lives, and an interview *is* a calendar event
      // in this schema. Without an entry here the page existed but nothing linked to it, which is the state
      // the whole interview feature was in until now.
      { to: '/interviews', label: 'Interviews', icon: Mic, group: 'Schedule', exact: true },
      // Before this, an invitation was only reachable from the one builder profile it was created
      // on — plans/UI Wave 3 "Build a central invitation management hub".
      { to: '/interviews/invitations', label: 'Invitations', icon: Send, group: 'Schedule' },
    ],
  },
  {
    id: 'signals',
    label: 'Signals',
    icon: Mail,
    // Exports is owned here rather than under Discover so it has exactly one
    // owning area: an item listed under an area that doesn't own its prefix
    // swaps the rail out from under the user on click (see nav-config.test.ts).
    routes: ['/alerts', '/exports'],
    items: [
      { to: '/alerts', label: 'Inbox', icon: Mail, group: 'Signals', badge: 'unreadAlerts' },
      { to: '/exports', label: 'Exports', icon: Download, group: 'Signals' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: Users,
    routes: ['/settings', '/me', '/status', '/team'],
    items: [
      { to: '/me', label: 'Account', icon: CircleUser, group: 'Account' },
      { to: '/settings/team', label: 'Team', icon: Users, group: 'Organization' },
      { to: '/team/activity', label: 'Team activity', icon: History, group: 'Organization' },
      { to: '/settings/billing', label: 'Billing', icon: CreditCard, group: 'Organization', exact: true },
      { to: '/settings/privacy', label: 'Privacy', icon: Shield, group: 'Compliance' },
      { to: '/settings/security', label: 'Security', icon: ShieldCheck, group: 'Compliance' },
      { to: '/status', label: 'Status', icon: Activity, group: 'Compliance' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: Siren,
    adminOnly: true,
    routes: ['/admin'],
    // Derived from `ADMIN_DESTINATIONS`, which the compiler holds against the route files on disk.
    items: ADMIN_NAV_ITEMS,
  },
]

/** Areas the current viewer may see. */
export function visibleAreas(isAdmin: boolean): readonly NavArea[] {
  return NAV_AREAS.filter((area) => !area.adminOnly || isAdmin)
}

/**
 * Which area owns `pathname`.
 *
 * Prefixes are compared longest-first so a more specific area wins over a
 * shorter one that happens to share a stem. Falls back to the first visible
 * area rather than returning null: an authenticated dashboard route always has
 * to light *something*, and a null area would render an empty level-2 panel.
 */
export function resolveActiveArea(pathname: string, isAdmin: boolean): NavArea {
  const areas = visibleAreas(isAdmin)
  const candidates = areas
    .flatMap((area) => area.routes.map((route) => ({ area, route })))
    .sort((a, b) => b.route.length - a.route.length)

  for (const { area, route } of candidates) {
    if (pathname === route || pathname.startsWith(`${route}/`)) return area
  }
  return areas[0]
}

/** Whether a level-2 item is the one currently open. */
export function isItemActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)
}

/**
 * Breadcrumb for the topbar: the area, then the open destination. Returns a
 * single crumb on an area's landing page so the bar doesn't read
 * "Home › Home".
 */
export function breadcrumbFor(pathname: string, isAdmin: boolean): string[] {
  const area = resolveActiveArea(pathname, isAdmin)
  const item = area.items.find((candidate) => isItemActive(candidate, pathname))
  if (!item || item.label === area.label) return [area.label]
  return [area.label, item.label]
}

/** Level-2 items grouped in declaration order, for rendering group headings. */
export function groupedItems(area: NavArea): Array<{ group: string | undefined; items: NavItem[] }> {
  const groups: Array<{ group: string | undefined; items: NavItem[] }> = []
  for (const item of area.items) {
    const last = groups[groups.length - 1]
    if (last && last.group === item.group) last.items.push(item)
    else groups.push({ group: item.group, items: [item] })
  }
  return groups
}
