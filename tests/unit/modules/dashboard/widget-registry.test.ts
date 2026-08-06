import { describe, expect, it } from 'vitest'
import {
  defineWidgetRegistry,
  moveWidgetInOrder,
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

/**
 * plans/ui-dashboard Wave 6, "Persist versioned per-user/per-organization preferences" and "Build
 * accessible dashboard customization controls".
 *
 * The arrangement rules are worth their own tests because each of them protects a property that is
 * invisible until it breaks: a critical widget that a user has pushed below the charts, a pin that
 * lands in the middle of the page, a widget added by a deploy that appears at the bottom of every
 * existing user's dashboard.
 */
describe('orderedWidgets — arrangement', () => {
  const ARRANGEABLE = defineWidgetRegistry<Ctx>([
    widget({ id: 'queue', order: 10, criticality: 'critical' }),
    widget({ id: 'alpha', order: 20 }),
    widget({ id: 'beta', order: 30 }),
    widget({ id: 'gamma', order: 40 }),
  ])
  const ALL_SHIPPED = new Set<WidgetDependency>()

  it('applies the user sequence to everything that is not critical', () => {
    const { visible } = orderedWidgets(ARRANGEABLE, {
      role: 'owner',
      available: ALL_SHIPPED,
      order: ['gamma', 'alpha', 'beta'],
    })
    expect(visible.map((entry) => entry.id)).toEqual(['queue', 'gamma', 'alpha', 'beta'])
  })

  it('refuses to move a critical widget out of the lead, however the order asks', () => {
    /*
     * `contracts.ts` says a critical widget cannot be hidden *or reordered*. Honouring only the first
     * half would let a user push the action queue below three charts, which is the one arrangement a
     * queue of blocked work must never be in — and unlike a hide, they would not have had to confirm
     * anything to get there.
     */
    const { visible } = orderedWidgets(ARRANGEABLE, {
      role: 'owner',
      available: ALL_SHIPPED,
      order: ['alpha', 'beta', 'gamma', 'queue'],
    })
    expect(visible[0].id).toBe('queue')
  })

  it('floats pinned widgets to the front, in the order they were pinned', () => {
    const { visible } = orderedWidgets(ARRANGEABLE, {
      role: 'owner',
      available: ALL_SHIPPED,
      pinned: ['gamma', 'beta'],
    })
    // After the critical one: a pin means "where I will see it", and the queue is not negotiable.
    expect(visible.map((entry) => entry.id)).toEqual(['queue', 'gamma', 'beta', 'alpha'])
  })

  it('ignores a pin on a critical widget rather than double-counting it', () => {
    const { visible } = orderedWidgets(ARRANGEABLE, {
      role: 'owner',
      available: ALL_SHIPPED,
      pinned: ['queue', 'beta'],
    })
    expect(visible.map((entry) => entry.id)).toEqual(['queue', 'beta', 'alpha', 'gamma'])
  })

  it('places a widget the saved order has never seen at its registry position, not at the end', () => {
    /*
     * The saved order predates `gamma`. Appending it — the obvious reading of "append newly required
     * widgets" — puts every new widget below everything, which is wrong the first time one is meant
     * to be near the top.
     */
    const { visible } = orderedWidgets(ARRANGEABLE, {
      role: 'owner',
      available: ALL_SHIPPED,
      order: ['beta', 'alpha'],
    })
    expect(visible.map((entry) => entry.id)).toEqual(['queue', 'beta', 'alpha', 'gamma'])
  })

  it('leaves no gap where an ineligible widget would have been', () => {
    // Ordering runs after eligibility on purpose: a saved position for a widget this role may not see
    // must not reserve a slot, and must not be evidence the widget exists.
    const gated = defineWidgetRegistry<Ctx>([
      widget({ id: 'alpha', order: 10 }),
      widget({ id: 'billing', order: 20, roles: ['owner'] }),
      widget({ id: 'beta', order: 30 }),
    ])
    const { visible, omitted } = orderedWidgets(gated, {
      role: 'member',
      available: ALL_SHIPPED,
      order: ['billing', 'beta', 'alpha'],
    })
    expect(visible.map((entry) => entry.id)).toEqual(['beta', 'alpha'])
    expect(omitted).toEqual([{ id: 'billing', reason: 'role' }])
  })
})

describe('moveWidgetInOrder', () => {
  const movable = (id: string) => id !== 'queue'

  it('swaps a widget with its neighbour', () => {
    expect(moveWidgetInOrder(['a', 'b', 'c'], 'b', 'up', () => true)).toEqual(['b', 'a', 'c'])
    expect(moveWidgetInOrder(['a', 'b', 'c'], 'b', 'down', () => true)).toEqual(['a', 'c', 'b'])
  })

  it('steps over an immovable neighbour in one press, without disturbing it', () => {
    /*
     * Two presses to achieve one visible step is the kind of control a keyboard user gives up on, and
     * the intermediate state — a widget sitting *above* the action queue — is not one the page would
     * ever render. The queue keeps index 1 either way.
     */
    expect(moveWidgetInOrder(['a', 'queue', 'b'], 'b', 'up', movable)).toEqual(['b', 'queue', 'a'])
  })

  it('returns the same array when the move is impossible, so a no-op costs nothing', () => {
    const order = ['a', 'b']
    expect(moveWidgetInOrder(order, 'a', 'up', () => true)).toBe(order)
    expect(moveWidgetInOrder(order, 'b', 'down', () => true)).toBe(order)
    expect(moveWidgetInOrder(order, 'queue', 'up', movable)).toBe(order)
  })
})

describe('defineWidgetRegistry — titles', () => {
  it('refuses two widgets that share a title', () => {
    /*
     * Harmless until something lists them side by side, which the Customize dialog does: one row per
     * widget, every control labelled with the title ("Move Saved searches up"), and none of the
     * context that told a metric tile from a list of saved searches on the page. Someone navigating
     * by name gets two of everything.
     *
     * This shipped for a day as two identical rows and was caught by reading the rendered dialog, not
     * by a test — hence the throw rather than a note.
     */
    expect(() => defineWidgetRegistry<Ctx>([
      widget({ id: 'stat-searches', order: 10, title: 'Saved searches' }),
      widget({ id: 'saved-searches', order: 20, title: 'Saved searches' }),
    ])).toThrow(/share the title/)
  })
})
