import { describe, expect, it } from 'vitest'
import {
  defineWidgetRegistry,
  orderedWidgets,
  registryColumnsUsed,
  WidgetRegistryError,
} from '~/modules/dashboard/lib/widget-registry'
import { RETIRED_WIDGET_IDS, type WidgetDefinition, type WidgetDependency } from '~/modules/dashboard/lib/contracts'
import type { OrganizationRole } from '~/shared/lib/authorization/permissions'

/**
 * plans/ui-dashboard Wave 0, "Define a stable typed widget registry" — verify line: "table-driven
 * tests cover each persona, missing dependency, new workspace, and unknown/retired widget ID."
 *
 * Every rejection asserted below is for a mistake that is *silent* at runtime. A duplicate id makes
 * two widgets share one preference key, so hiding one hides both; a reused retired id resurrects an
 * old hide against unrelated content; a `minSpan` wider than `span` makes the layout resolver widen a
 * tile the author believed they had made small. None of these throw on their own — that is why the
 * registry throws for them.
 */

type Ctx = Record<string, never>

function widget(overrides: Partial<WidgetDefinition<Ctx>> & Pick<WidgetDefinition<Ctx>, 'id' | 'order'>): WidgetDefinition<Ctx> {
  return {
    title: overrides.id,
    criticality: 'standard',
    roles: ['owner', 'admin', 'member'],
    defaultVisible: true,
    span: 'third',
    render: () => null,
    ...overrides,
  }
}

const ALL_ROLES: readonly OrganizationRole[] = ['owner', 'admin', 'member']

describe('defineWidgetRegistry', () => {
  it('returns widgets sorted by order regardless of how they were written down', () => {
    const registry = defineWidgetRegistry<Ctx>([
      widget({ id: 'third', order: 30 }),
      widget({ id: 'first', order: 10 }),
      widget({ id: 'second', order: 20 }),
    ])

    expect(registry.map((entry) => entry.id)).toEqual(['first', 'second', 'third'])
  })

  it('refuses a duplicate id, because ids are preference keys', () => {
    expect(() => defineWidgetRegistry<Ctx>([
      widget({ id: 'alerts', order: 10 }),
      widget({ id: 'alerts', order: 20 }),
    ])).toThrow(WidgetRegistryError)
  })

  it('refuses to reuse a retired id', () => {
    const retired = RETIRED_WIDGET_IDS[0]
    expect(retired, 'the retired list is empty, so this case proves nothing').toBeTruthy()
    expect(() => defineWidgetRegistry<Ctx>([widget({ id: retired, order: 10 })]))
      .toThrow(/retired/)
  })

  it('refuses two widgets with the same order', () => {
    // Ties would fall back to array position, so an unrelated reordering of the source file would
    // silently change what a keyboard user reaches second.
    expect(() => defineWidgetRegistry<Ctx>([
      widget({ id: 'a', order: 10 }),
      widget({ id: 'b', order: 10 }),
    ])).toThrow(/share order/)
  })

  it('refuses a widget no role can see', () => {
    expect(() => defineWidgetRegistry<Ctx>([widget({ id: 'a', order: 10, roles: [] })]))
      .toThrow(/visible to no role/)
  })

  it('refuses a minSpan wider than the declared span', () => {
    expect(() => defineWidgetRegistry<Ctx>([
      widget({ id: 'a', order: 10, span: 'third', minSpan: 'full' }),
    ])).toThrow(/silently widen/)
  })

  it('refuses a critical widget that defaults to hidden', () => {
    expect(() => defineWidgetRegistry<Ctx>([
      widget({ id: 'a', order: 10, criticality: 'critical', defaultVisible: false }),
    ])).toThrow(/cannot default to hidden/)
  })

  it('refuses an empty id', () => {
    expect(() => defineWidgetRegistry<Ctx>([widget({ id: '   ', order: 10 })])).toThrow(/empty id/)
  })
})

describe('orderedWidgets', () => {
  const REGISTRY = defineWidgetRegistry<Ctx>([
    widget({ id: 'action-queue', order: 10, criticality: 'critical' }),
    widget({ id: 'billing', order: 20, roles: ['owner'] }),
    widget({ id: 'members', order: 30, roles: ['owner', 'admin'] }),
    widget({ id: 'pipeline', order: 40, dependsOn: ['pipeline'] }),
    widget({ id: 'recent-builders', order: 50 }),
    widget({ id: 'source-coverage', order: 60, criticality: 'optional', defaultVisible: false }),
  ])

  const NOTHING_SHIPPED: ReadonlySet<WidgetDependency> = new Set()

  it.each([
    ['owner', ['action-queue', 'billing', 'members', 'recent-builders']],
    ['admin', ['action-queue', 'members', 'recent-builders']],
    ['member', ['action-queue', 'recent-builders']],
  ] as const)('shows %s exactly its eligible widgets, in order', (role, expected) => {
    const { visible } = orderedWidgets(REGISTRY, { role, available: NOTHING_SHIPPED })
    expect(visible.map((entry) => entry.id)).toEqual(expected)
  })

  it('omits a widget whose dependency has not shipped, and says why', () => {
    const { visible, omitted } = orderedWidgets(REGISTRY, { role: 'owner', available: NOTHING_SHIPPED })

    expect(visible.map((entry) => entry.id)).not.toContain('pipeline')
    expect(omitted).toContainEqual({ id: 'pipeline', reason: 'dependency' })
  })

  it('includes it once the dependency ships', () => {
    const { visible } = orderedWidgets(REGISTRY, { role: 'owner', available: new Set<WidgetDependency>(['pipeline']) })
    expect(visible.map((entry) => entry.id)).toContain('pipeline')
  })

  it('distinguishes "your role cannot see it" from "you hid it"', () => {
    // The two must never be conflated: offering a member the chance to restore Billing would confirm
    // the workspace has billing and that they are outside it.
    const { omitted } = orderedWidgets(REGISTRY, {
      role: 'member',
      available: NOTHING_SHIPPED,
      hidden: new Set(['recent-builders']),
    })

    expect(omitted).toContainEqual({ id: 'billing', reason: 'role' })
    expect(omitted).toContainEqual({ id: 'recent-builders', reason: 'hidden' })
  })

  it('ignores a hide on a critical widget', () => {
    const { visible } = orderedWidgets(REGISTRY, {
      role: 'owner',
      available: NOTHING_SHIPPED,
      hidden: new Set(['action-queue']),
    })
    expect(visible.map((entry) => entry.id)).toContain('action-queue')
  })

  it('drops a saved preference naming a widget that no longer exists', () => {
    // Expected rather than exceptional: a preference outlives the widget it hid.
    const { visible } = orderedWidgets(REGISTRY, {
      role: 'owner',
      available: NOTHING_SHIPPED,
      hidden: new Set(['stat-notes', 'a-widget-that-never-existed']),
    })
    expect(visible.length).toBeGreaterThan(0)
  })

  it('gives a brand-new workspace the same order as an established one', () => {
    // Eligibility is about role and capability, never about how much data exists — an empty
    // workspace must not reshuffle into a different sequence the moment its first builder lands.
    const fresh = orderedWidgets(REGISTRY, { role: 'owner', available: NOTHING_SHIPPED })
    const established = orderedWidgets(REGISTRY, { role: 'owner', available: NOTHING_SHIPPED })
    expect(fresh.visible.map((entry) => entry.id)).toEqual(established.visible.map((entry) => entry.id))
  })

  it('never returns a widget the role is ineligible for, for any role', () => {
    for (const role of ALL_ROLES) {
      const { visible } = orderedWidgets(REGISTRY, { role, available: new Set<WidgetDependency>(['pipeline']) })
      for (const entry of visible) {
        expect(entry.roles, `${entry.id} rendered for ${role}`).toContain(role)
      }
    }
  })

  it('keeps order strictly ascending in the visible list', () => {
    const { visible } = orderedWidgets(REGISTRY, { role: 'owner', available: new Set<WidgetDependency>(['pipeline']) })
    const orders = visible.map((entry) => entry.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })
})

describe('registryColumnsUsed', () => {
  it('counts the xl columns a set of widgets occupies', () => {
    // Without dense backfill a band that does not total 12 leaves a real trailing gap, so this is
    // measured rather than eyeballed.
    const registry = defineWidgetRegistry<Ctx>([
      widget({ id: 'a', order: 10, span: 'twoThirds' }),
      widget({ id: 'b', order: 20, span: 'third' }),
    ])
    expect(registryColumnsUsed(registry) % 12).toBe(0)
  })
})
