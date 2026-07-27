import { describe, expect, it } from 'vitest'
import {
  NAV_AREAS,
  breadcrumbFor,
  groupedItems,
  isItemActive,
  resolveActiveArea,
  visibleAreas,
} from '~/modules/dashboard/ui/shell/nav-config'

describe('resolveActiveArea', () => {
  it.each([
    ['/dashboard', 'home'],
    ['/search', 'discover'],
    ['/solutions', 'discover'],
    ['/exports', 'signals'],
    ['/sprints', 'pipeline'],
    ['/calendar', 'pipeline'],
    ['/alerts', 'signals'],
    ['/settings/team', 'workspace'],
    ['/settings/security', 'workspace'],
    ['/me', 'workspace'],
  ])('maps %s to the %s area', (pathname, expected) => {
    expect(resolveActiveArea(pathname, false).id).toBe(expected)
  })

  // The reason shell C needs prefix ownership at all: these paths have no
  // level-2 entry of their own, and the rail still has to light up.
  it.each([
    ['/sprints/abc123', 'pipeline'],
    ['/sprints/new', 'pipeline'],
    ['/builder/xyz789', 'discover'],
    ['/settings/billing/return', 'workspace'],
  ])('resolves the deep link %s to %s', (pathname, expected) => {
    expect(resolveActiveArea(pathname, false).id).toBe(expected)
  })

  it('hides the admin area from non-admins and never resolves into it', () => {
    expect(visibleAreas(false).some((a) => a.id === 'admin')).toBe(false)
    expect(resolveActiveArea('/admin/disputes', false).id).not.toBe('admin')
  })

  it('resolves admin routes for admins', () => {
    expect(resolveActiveArea('/admin/disputes', true).id).toBe('admin')
    expect(resolveActiveArea('/admin/plan-requests', true).id).toBe('admin')
  })

  it('falls back to the first visible area for an unmapped path', () => {
    // An empty level-2 panel would look broken, so resolution never returns null.
    expect(resolveActiveArea('/some/unmapped/route', false).id).toBe('home')
  })

  it('does not match a partial path segment', () => {
    // `/searchable` must not be captured by the `/search` prefix.
    expect(resolveActiveArea('/searchable', false).id).toBe('home')
  })
})

describe('isItemActive', () => {
  const sprints = { to: '/sprints', label: 'Sprints', icon: () => null, exact: true }
  const calendar = { to: '/calendar', label: 'Calendar', icon: () => null }

  it('keeps an exact item dark on a child route', () => {
    expect(isItemActive(sprints, '/sprints')).toBe(true)
    expect(isItemActive(sprints, '/sprints/abc')).toBe(false)
  })

  it('lights a prefix item on its child routes', () => {
    expect(isItemActive(calendar, '/calendar')).toBe(true)
    expect(isItemActive(calendar, '/calendar/2026-07')).toBe(true)
  })

  it('does not light on a sibling that merely shares a stem', () => {
    expect(isItemActive(calendar, '/calendar-export')).toBe(false)
  })
})

describe('breadcrumbFor', () => {
  it('returns one crumb on an area landing page', () => {
    // Overview is the landing page of Home, so the item label differs from the
    // area label and both crumbs carry information.
    expect(breadcrumbFor('/dashboard', false)).toEqual(['Home', 'Overview'])
  })

  it('names the area and the open destination', () => {
    expect(breadcrumbFor('/settings/security', false)).toEqual(['Workspace', 'Security'])
    expect(breadcrumbFor('/admin/disputes', true)).toEqual(['Admin', 'Disputes'])
  })

  it('falls back to the area alone when the route has no level-2 entry', () => {
    expect(breadcrumbFor('/sprints/abc123', false)).toEqual(['Pipeline'])
  })
})

describe('registry integrity', () => {
  it('has unique area ids', () => {
    const ids = NAV_AREAS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares absolute routes and destinations', () => {
    for (const area of NAV_AREAS) {
      for (const route of area.routes) expect(route.startsWith('/')).toBe(true)
      for (const item of area.items) expect(item.to.startsWith('/')).toBe(true)
    }
  })

  it('keeps every destination inside an area that owns its prefix or is reachable', () => {
    // Guards the case that silently breaks shell C: an item listed under one
    // area whose path resolves to a different area, so clicking it swaps the
    // rail out from under the user.
    for (const area of NAV_AREAS) {
      for (const item of area.items) {
        const owner = resolveActiveArea(item.to, true)
        const shared = NAV_AREAS.some(
          (other) => other.id === owner.id && other.items.some((i) => i.to === item.to),
        )
        expect(shared, `${item.to} listed in ${area.id} resolves to ${owner.id}`).toBe(true)
      }
    }
  })

  it('groups level-2 items in declaration order without splitting a group', () => {
    const admin = NAV_AREAS.find((a) => a.id === 'admin')!
    expect(groupedItems(admin).map((g) => g.group)).toEqual(['Operations', 'Money', 'Public'])
    expect(groupedItems(admin).reduce((n, g) => n + g.items.length, 0)).toBe(admin.items.length)
  })
})
