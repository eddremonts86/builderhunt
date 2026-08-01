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
  Download, Gauge, History, Inbox, Layers, LayoutDashboard, Lightbulb, ListChecks, Mail, Map, Plug, Plus, RotateCcw,
  Mic, Send,
  Search, Shield, ShieldAlert, ShieldCheck, Siren, Users,
} from 'lucide-react'

type IconComponent = React.ComponentType<{ className?: string }>

export interface NavItem {
  to: string
  label: string
  icon: IconComponent
  /** Optional group heading rendered above this item in the level-2 panel. */
  group?: string
  /** Which live counter feeds this item's badge, if any. */
  badge?: 'unreadAlerts' | 'planRequests'
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
    items: [
      { to: '/admin/metrics', label: 'Metrics', icon: Activity, group: 'Operations' },
      { to: '/admin/operations', label: 'Operations', icon: Cog, group: 'Operations' },
      { to: '/admin/integrations', label: 'Integrations', icon: Plug, group: 'Operations' },
      { to: '/admin/users', label: 'Users', icon: Users, group: 'Operations' },
      { to: '/admin/plan-requests', label: 'Plan requests', icon: Inbox, group: 'Operations', badge: 'planRequests' },
      { to: '/admin/incidents', label: 'Incidents', icon: AlertTriangle, group: 'Operations' },
      { to: '/admin/claims', label: 'Claims', icon: BadgeCheck, group: 'Operations' },
      { to: '/admin/abuse', label: 'Abuse console', icon: Siren, group: 'Operations' },
      { to: '/admin/billing', label: 'Billing ops', icon: Gauge, group: 'Money' },
      { to: '/admin/refunds', label: 'Refunds', icon: RotateCcw, group: 'Money' },
      { to: '/admin/disputes', label: 'Disputes', icon: ShieldAlert, group: 'Money' },
      // Content is the hub over all three public surfaces; Changelog and
      // Roadmap stay listed because they are the two people navigate to
      // directly, and both render the same components the hub's tabs do.
      { to: '/admin/content', label: 'Content', icon: Layers, group: 'Public', exact: true },
      { to: '/admin/changelog', label: 'Changelog', icon: BookOpen, group: 'Public' },
      { to: '/admin/roadmap', label: 'Roadmap', icon: Map, group: 'Public' },
    ],
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
