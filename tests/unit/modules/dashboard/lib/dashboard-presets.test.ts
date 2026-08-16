import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_PRESETS,
  DashboardPresetError,
  assertPresetsMatchRegistry,
  dashboardPresetFor,
  presetOrder,
  resolvePresetLayout,
} from '~/modules/dashboard/lib/dashboard-presets'
import { HOME_WIDGETS } from '~/modules/dashboard/components/DashboardPage'
import { ONBOARDING_PRESETS } from '~/shared/lib/onboarding-v2'

/**
 * The segment presets (plan: phase-2/04-dashboard-personalizado, task 2).
 *
 * Checked against the real registry rather than a fixture. A preset is a list of widget ids, and the
 * failure worth catching is the one where those ids stop matching the dashboard — which a fixture
 * would hide by definition.
 */

const EMPTY = { hiddenWidgetIds: [], pinnedWidgetIds: [], orderedWidgetIds: [] }

const registryIds = new Set(HOME_WIDGETS.map((widget) => widget.id))
const criticalIds = new Set(
  HOME_WIDGETS.filter((widget) => widget.criticality === 'critical').map((widget) => widget.id),
)

describe('every route has a preset', () => {
  it('covers exactly the presets the segmentation knows, with no extras', () => {
    expect(Object.keys(DASHBOARD_PRESETS).sort()).toEqual([...ONBOARDING_PRESETS].sort())
  })

  it('names only widgets the registry actually has', () => {
    expect(() => assertPresetsMatchRegistry(registryIds, criticalIds)).not.toThrow()
  })

  it('gives each route a CTA that goes somewhere', () => {
    for (const preset of Object.values(DASHBOARD_PRESETS)) {
      expect(preset.cta.heading.length, preset.id).toBeGreaterThan(0)
      expect(preset.cta.label.length, preset.id).toBeGreaterThan(0)
      expect(preset.cta.to.startsWith('/'), preset.id).toBe(true)
      expect(preset.cta.description.length, preset.id).toBeGreaterThan(20)
      // One screen saying the same thing twice reads as a template nobody filled in.
      expect(preset.cta.label, preset.id).not.toBe(preset.cta.heading)
    }
  })
})

/**
 * The property the whole rollout rests on: the dashboard everybody has today must not move. If
 * `general` resolved to anything other than the identity, every account without a segment — which is
 * every account until the ramp starts — would get a changed page.
 */
describe('the general route changes nothing', () => {
  it('leads with nothing and hides nothing', () => {
    expect(DASHBOARD_PRESETS.general.lead).toEqual([])
    expect(DASHBOARD_PRESETS.general.hidden).toEqual([])
    expect(presetOrder(DASHBOARD_PRESETS.general)).toBeUndefined()
  })

  it('leaves a user\'s layout exactly as it was', () => {
    const saved = { hiddenWidgetIds: ['activity'], pinnedWidgetIds: ['alerts'], orderedWidgetIds: ['alerts', 'activity'] }
    const layout = resolvePresetLayout(DASHBOARD_PRESETS.general, saved)
    expect(layout.order).toEqual(saved.orderedWidgetIds)
    expect([...layout.hidden]).toEqual(['activity'])
    expect(layout.pinned).toEqual(saved.pinnedWidgetIds)
  })

  /** Nothing saved and nothing to apply — the page everybody has today, unchanged. */
  it('resolves to nothing at all for a fresh workspace', () => {
    const layout = resolvePresetLayout(DASHBOARD_PRESETS.general, EMPTY)
    expect(layout.order).toBeUndefined()
    expect(layout.hidden.size).toBe(0)
    expect(layout.pinned).toEqual([])
  })

  /** `other` is the general experience, not a fifth variant — the same claim the onboarding makes. */
  it('is what `other` resolves to as well', () => {
    expect(DASHBOARD_PRESETS.other.lead).toEqual(DASHBOARD_PRESETS.general.lead)
    expect(DASHBOARD_PRESETS.other.hidden).toEqual(DASHBOARD_PRESETS.general.hidden)
    expect(DASHBOARD_PRESETS.other.cta).toEqual(DASHBOARD_PRESETS.general.cta)
  })

  /**
   * The copy the empty dashboard has always shown, word for word. Changing it would change the
   * product for every account without a segment, which is every account until the ramp starts —
   * and the visual baseline for the empty dashboard is what proves it did not.
   */
  it('keeps the empty-state copy it had before there were routes', () => {
    expect(DASHBOARD_PRESETS.general.cta.heading).toBe('Run your first hunt')
    expect(DASHBOARD_PRESETS.general.cta.label).toBe('Start your first hunt')
  })
})

describe('anything unexpected falls back', () => {
  it.each([null, undefined, 'recruiter', ''])('resolves %s to the general route', (value) => {
    expect(dashboardPresetFor(value as never).id).toBe('general')
  })
})

/**
 * If two routes promoted the same widgets in the same order, the segmentation would be a change of
 * heading — the failure mode the phase README names by name.
 */
describe('the routes actually differ', () => {
  it('gives hiring, investing and building different lead orders', () => {
    const { hiring, investing, building } = DASHBOARD_PRESETS
    expect(hiring.lead).not.toEqual(investing.lead)
    expect(investing.lead).not.toEqual(building.lead)
    expect(hiring.lead).not.toEqual(building.lead)
  })

  it('leads each route with a widget that belongs to it', () => {
    expect(DASHBOARD_PRESETS.hiring.lead[0]).toBe('review')
    expect(DASHBOARD_PRESETS.investing.lead[0]).toBe('saved-searches')
    expect(DASHBOARD_PRESETS.building.lead[0]).toBe('profile-owner')
  })

  /**
   * The empty-page failure, asserted rather than reasoned about. A route whose promoted widgets all
   * vanish when empty renders a blank dashboard to a new account, which reads as broken.
   */
  it('leads every route with at least one widget that renders when empty', () => {
    const survivesEmpty = new Set(
      HOME_WIDGETS.filter((widget) => widget.whenEmpty !== 'hide').map((widget) => widget.id),
    )
    for (const preset of Object.values(DASHBOARD_PRESETS)) {
      if (preset.lead.length === 0) continue
      expect(preset.lead.some((id) => survivesEmpty.has(id)), preset.id).toBe(true)
    }
  })
})

describe('what a preset may not do', () => {
  it('refuses a widget the registry does not have', () => {
    expect(() => assertPresetsMatchRegistry(new Set(['action-queue']), criticalIds))
      .toThrow(DashboardPresetError)
  })

  /**
   * A user preference already cannot hide the action queue. A preset must not be the loophole:
   * blocked work pushed off the page is the one arrangement the queue must never be in.
   */
  it('refuses to hide a critical widget', () => {
    expect(() => assertPresetsMatchRegistry(registryIds, new Set(['review'])))
      .toThrow(/hides critical widget "review"/)
  })

  it('never hides a critical widget as written', () => {
    for (const preset of Object.values(DASHBOARD_PRESETS)) {
      for (const id of preset.hidden) {
        expect(criticalIds.has(id), `${preset.id} hides ${id}`).toBe(false)
      }
    }
  })
})

/**
 * A preset applies to what nobody has arranged, one dimension at a time. The alternative — a single
 * "has this been customised?" flag — would drop the whole route's layout the moment somebody pinned
 * one tile, and merging instead would make a preset-hidden widget impossible to restore.
 */
describe('applying a preset over a saved layout', () => {
  it('hands the lead order through for a route that has one', () => {
    expect(presetOrder(DASHBOARD_PRESETS.hiring)).toEqual(DASHBOARD_PRESETS.hiring.lead)
    expect(resolvePresetLayout(DASHBOARD_PRESETS.hiring, EMPTY).order)
      .toEqual(DASHBOARD_PRESETS.hiring.lead)
  })

  it('applies the route\'s hides only while the person has none of their own', () => {
    expect([...resolvePresetLayout(DASHBOARD_PRESETS.investing, EMPTY).hidden].sort())
      .toEqual(['review', 'shortlists'])

    // One hide of their own, and their set is the truth — including the absence of `review`, which
    // is what makes "Restore" a control that works rather than one the route undoes.
    const theirs = resolvePresetLayout(DASHBOARD_PRESETS.investing, { ...EMPTY, hiddenWidgetIds: ['activity'] })
    expect([...theirs.hidden]).toEqual(['activity'])
  })

  it('lets a saved order outrank the route entirely', () => {
    const layout = resolvePresetLayout(DASHBOARD_PRESETS.building, { ...EMPTY, orderedWidgetIds: ['alerts'] })
    expect(layout.order).toEqual(['alerts'])
  })

  /** Clearing a list is how the route's default comes back — the dialog's reset already writes that. */
  it('restores the route once the saved lists are cleared', () => {
    const layout = resolvePresetLayout(DASHBOARD_PRESETS.building, EMPTY)
    expect(layout.order).toEqual(DASHBOARD_PRESETS.building.lead)
    expect([...layout.hidden].sort()).toEqual([...DASHBOARD_PRESETS.building.hidden].sort())
  })

  it('never takes a pin from a route, because no route pins', () => {
    for (const preset of Object.values(DASHBOARD_PRESETS)) {
      const layout = resolvePresetLayout(preset, { ...EMPTY, pinnedWidgetIds: ['alerts'] })
      expect(layout.pinned, preset.id).toEqual(['alerts'])
    }
  })
})
