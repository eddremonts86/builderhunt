/**
 * Segment presets for the dashboard (plan: phase-2/04-dashboard-personalizado).
 *
 * ## A preset is a partial instruction, not a layout
 *
 * Each one names the widgets its route wants first and the ones it wants out of the way. Everything
 * it does not mention keeps its registry position — exactly the semantics `mergeWidgetOrder` already
 * gives a user's saved order, and for the same reason: a widget added by a deploy should land where
 * its author put it, not at the bottom of four presets nobody remembered to edit.
 *
 * That is also what keeps this file short enough to read. A preset that listed all twenty-one
 * widgets would be four near-identical copies of the registry, and the differences between the
 * routes — which is the only thing worth reviewing — would be invisible.
 *
 * ## `general` is empty on purpose
 *
 * It names nothing and hides nothing, so resolving it is provably the identity function and the
 * dashboard everybody has today is unchanged. `other`, a null segment, a failed request and a
 * segment value from a future build all land on it. A preset that "reproduced" the current layout
 * by listing it would drift from the registry the first time somebody reordered a band.
 *
 * ## What a preset may not do
 *
 * It may not hide a `critical` widget, and it may not name an id the registry does not have. Both
 * are authoring mistakes that are silent at runtime — the first would make a preset a way around a
 * rule user preferences already respect, the second a preset that quietly does less than it says.
 * `assertPresetsMatchRegistry` throws on either, at module load, the way `defineWidgetRegistry`
 * does.
 *
 * A preset is presentation. It grants nothing: role and dependency eligibility are resolved first,
 * and the server authorizes every data source independently of all of this.
 */
import type { SegmentPreset } from '~/shared/lib/user-segments'

/**
 * Where a route's call to action goes.
 *
 * A closed union rather than a string, so "a preset never invents a destination" is enforced by the
 * compiler rather than asserted in a comment — and so the router's own typed `to` accepts it without
 * a cast that would let a typo through as a dead link.
 */
export type DashboardCtaDestination = '/search' | '/sprints' | '/me' | '/me/profile'

export interface DashboardPresetCta {
  /** The tile's heading. */
  heading: string
  /** The button, which must not repeat the heading — one screen saying the same thing twice. */
  label: string
  to: DashboardCtaDestination
  description: string
}

export interface DashboardPreset {
  id: SegmentPreset
  /**
   * Widget ids to lead with, in this order. Unmentioned widgets keep their registry position after
   * these, so this is a promotion list rather than a layout.
   */
  lead: readonly string[]
  /**
   * Widget ids this route hides by default.
   *
   * A default, not a rule: the Customize dialog restores them like any other hidden widget, and a
   * saved preference outranks this. Nothing here is a permission.
   */
  hidden: readonly string[]
  /** The one action this route offers when the page is thin. */
  cta: DashboardPresetCta
}

/**
 * The four routes.
 *
 * Each `lead` list answers one question — *what did this person come here to check?* — and each is
 * built from the empty-state analysis in `docs/architecture/dashboard-widget-inventory.md`: a route
 * whose promoted widgets all `hide` when empty renders a blank page to a new account, so every list
 * below leads with at least one widget that renders something either way.
 */
export const DASHBOARD_PRESETS: Record<SegmentPreset, DashboardPreset> = {
  general: {
    id: 'general',
    lead: [],
    hidden: [],
    /*
     * Word for word what this tile said before there were routes. The general route is what every
     * account has until it chooses a goal, so changing its copy would be changing the product for
     * everybody — and the visual baseline for the empty dashboard is the evidence that it did not.
     */
    cta: {
      heading: 'Run your first hunt',
      label: 'Start your first hunt',
      to: '/search',
      description: "Pick a topic you care about, a framework, a stack, a community, and we'll surface the people actively shipping in it.",
    },
  },

  /** `other` *is* the general experience, not a fifth variant. Same copy, said explicitly. */
  other: {
    id: 'other',
    lead: [],
    hidden: [],
    cta: {
      heading: 'Run your first hunt',
      label: 'Start your first hunt',
      to: '/search',
      description: "Pick a topic you care about, a framework, a stack, a community, and we'll surface the people actively shipping in it.",
    },
  },

  /**
   * Hiring reads as a pipeline: who is waiting on me, who did I shortlist, what is running.
   * `recommendations` leads the non-queue band because it is the one tile that has something to say
   * on day one — the shortlist and the review queue are both empty until somebody has worked.
   */
  hiring: {
    id: 'hiring',
    lead: ['review', 'shortlists', 'recommendations', 'sprints', 'upcoming', 'recent-builders'],
    // Source coverage is a connector-health view. It answers a question an operator asks, not one a
    // recruiter does, and it is one of the five widgets that costs its own request.
    hidden: ['source-mix'],
    cta: {
      heading: 'Start a sourcing sprint',
      label: 'Create a sprint',
      to: '/sprints',
      description: 'Give a role a deadline and let the sprint work the sources for you, so a shortlist exists before you go looking for one.',
    },
  },

  /**
   * Investing is about what is being built and by whom, so the saved searches doing the watching
   * lead, then what they turned up. `alert-volume` sits with them because on this route it is a
   * reading of the thesis rather than an operations chart.
   */
  investing: {
    id: 'investing',
    lead: ['saved-searches', 'alerts', 'discovery-trend', 'alert-volume', 'activity', 'recent-builders'],
    // Both are about running a hiring process, which this route does not have.
    hidden: ['review', 'shortlists'],
    cta: {
      heading: 'Save your first search',
      label: 'Run a search',
      to: '/search',
      description: 'Turn a thesis into a search that keeps running, and hear about what it finds instead of going back to look.',
    },
  },

  /**
   * The only route whose subject is the person reading it. It leads with their own profile and
   * keeps exactly one tile about other people, because a builder's dashboard that is mostly a
   * recruiting console is a recruiting console.
   *
   * The inventory names the risk this has to carry: `profile-owner` hides when there is no claim, so
   * a builder who has not claimed anything would be left with widgets about strangers. Hence the CTA
   * below, and hence `activity` — which renders its own copy rather than disappearing.
   */
  building: {
    id: 'building',
    lead: ['profile-owner', 'activity', 'recent-builders'],
    hidden: ['review', 'shortlists', 'source-mix', 'alert-volume'],
    /*
     * `/me/profile` rather than `/me` (plan: phase-2/07-perfiles-autogestionados).
     *
     * The `building` segment covers two sub-modalities — somebody with an indexed footprint to
     * claim, and somebody with none — and only one route serves both. `/me` needs a claim to show
     * anything, so it is a dead end for exactly the people this plan added; the self-managed editor
     * works for everyone in the segment, and a person with a claim loses nothing by starting there.
     */
    cta: {
      heading: 'Write your profile',
      label: 'Go to my profile',
      to: '/me/profile',
      description: 'Your own page, marked Self-managed — never verified, and never claiming to be. Attach work samples and decide who can see it.',
    },
  },
}

/** One place, so a caller never indexes the record with a value that might not be a key. */
export function dashboardPresetFor(preset: SegmentPreset | null | undefined): DashboardPreset {
  if (!preset) return DASHBOARD_PRESETS.general
  return DASHBOARD_PRESETS[preset] ?? DASHBOARD_PRESETS.general
}

/**
 * The sequence a preset asks for, ready to hand to `orderedWidgets` as its `order`.
 *
 * Returns `undefined` for a preset that leads with nothing, so `general` passes no order at all
 * rather than an empty array — the difference matters to `arrange`, which short-circuits on "no
 * order and no pins" and otherwise builds a rank map for nothing.
 */
export function presetOrder(preset: DashboardPreset): readonly string[] | undefined {
  return preset.lead.length > 0 ? preset.lead : undefined
}

export interface SavedLayout {
  hiddenWidgetIds: readonly string[]
  pinnedWidgetIds: readonly string[]
  orderedWidgetIds: readonly string[]
}

export interface ResolvedLayout {
  order: readonly string[] | undefined
  hidden: ReadonlySet<string>
  pinned: readonly string[]
}

/**
 * Combines a route's defaults with whatever the person has actually arranged.
 *
 * **A preset applies to what nobody has arranged, one dimension at a time.** An empty
 * `orderedWidgetIds` means nobody has ordered anything, so the route's lead order is the order; a
 * non-empty one is somebody's arrangement and wins outright. Hides work the same way, and pins are
 * always the user's — no route pins anything.
 *
 * Per dimension rather than wholesale, because the alternative loses information in both directions.
 * A single "has this been customised?" flag would drop the whole preset the moment somebody pinned
 * one tile. Merging instead — union the hides, splice the orders — would make a preset-hidden widget
 * impossible to restore: the union would put it straight back, and "Restore" is a control the
 * Customize dialog already offers.
 *
 * It also gives "restore the preset" a meaning with no new state: clearing a list is how you get the
 * route's default back, which is exactly what the dialog's reset already writes. No second API, no
 * second table, and no per-segment copy of a layout to keep in step.
 */
export function resolvePresetLayout(preset: DashboardPreset, saved: SavedLayout): ResolvedLayout {
  return {
    order: saved.orderedWidgetIds.length > 0 ? saved.orderedWidgetIds : presetOrder(preset),
    hidden: saved.hiddenWidgetIds.length > 0
      ? new Set(saved.hiddenWidgetIds)
      : new Set(preset.hidden),
    pinned: saved.pinnedWidgetIds,
  }
}

export class DashboardPresetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DashboardPresetError'
  }
}

/**
 * Checks every preset against the registry it will be resolved with.
 *
 * Called at module load beside the registry, so an id that no longer exists fails a build rather
 * than silently promoting nothing, and a preset that hides the action queue fails before it can
 * hide somebody's blocked work.
 */
export function assertPresetsMatchRegistry(
  knownIds: ReadonlySet<string>,
  criticalIds: ReadonlySet<string>,
): void {
  for (const preset of Object.values(DASHBOARD_PRESETS)) {
    for (const id of [...preset.lead, ...preset.hidden]) {
      if (!knownIds.has(id)) {
        throw new DashboardPresetError(
          `dashboard preset "${preset.id}" names widget "${id}", which the registry does not have`,
        )
      }
    }
    for (const id of preset.hidden) {
      if (criticalIds.has(id)) {
        throw new DashboardPresetError(
          `dashboard preset "${preset.id}" hides critical widget "${id}"; criticality is the product's decision, not a route's`,
        )
      }
    }
    const leadSet = new Set(preset.lead)
    if (leadSet.size !== preset.lead.length) {
      throw new DashboardPresetError(`dashboard preset "${preset.id}" names a widget twice in its lead order`)
    }
    for (const id of preset.hidden) {
      if (leadSet.has(id)) {
        throw new DashboardPresetError(
          `dashboard preset "${preset.id}" both leads with and hides "${id}"`,
        )
      }
    }
  }
}
