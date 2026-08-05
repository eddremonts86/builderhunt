/**
 * The one ordered widget registry (plans/ui-dashboard Wave 0, "Define a stable typed widget registry"
 * and "Make widget visual order equal DOM and focus order").
 *
 * ## Why eligibility is resolved here and not in the layout
 *
 * `resolveBentoLayout` already answers "how wide is this tile, and does it collapse when empty". What
 * it deliberately does not answer is "may this person see it at all", and the two must not merge: a
 * widget hidden by `isVisible` returning false is indistinguishable, from the outside, from a widget
 * whose data happened to be empty. Role and dependency eligibility is an authorization-shaped
 * decision, so it gets its own pass with its own tests and its own vocabulary
 * (`WidgetOmissionReason`).
 *
 * The server remains the authorization boundary. Nothing here keeps a member from seeing owner data;
 * the projection never sends it. This decides what to *render*, so a role change does not leave a
 * tile that says "—" where a number used to be.
 *
 * ## The ordering rule, and why it is a single number
 *
 * One sequence produces DOM order, focus order and visual order, in that order of authority. The
 * previous grid used `grid-flow-row-dense`, which backfills gaps by promoting a later tile into an
 * earlier hole — so the third widget in the DOM could paint second, and a keyboard user reached it
 * third. The file's own comment called that "acceptable here because every tile is an independent,
 * separately-labelled region"; the spec disagrees (structural problem 3), because the tiles contain
 * links and controls and the dashboard is ordered by urgency. An action queue that tabs out of order
 * is not an ordered action queue.
 *
 * So: dense placement is gone, this function is the only source of sequence, and
 * `dashboard-widget-order.spec.ts` compares bounding boxes against tab order at three widths.
 */

import { RETIRED_WIDGET_IDS, type WidgetDefinition, type WidgetDependency, type WidgetOmissionReason } from './contracts'
import { SPAN_COLUMNS, type BentoSpan } from '~/modules/dashboard/ui/bento/layout'
import type { OrganizationRole } from '~/shared/lib/authorization/permissions'

export class WidgetRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WidgetRegistryError'
  }
}

/**
 * Validates a registry once, at module load, and returns it frozen in order.
 *
 * Every check here is for a mistake that is silent at runtime and expensive later: a duplicate id
 * makes two widgets share one preference key; a reused retired id resurrects an old hide against new
 * content; a `minSpan` wider than `span` makes the resolver quietly widen a tile the author thought
 * they had made small; an empty role list produces a widget nobody ever sees and nobody notices is
 * missing.
 *
 * Throwing at import is deliberate. These are authoring errors, and a dashboard that renders with one
 * widget silently wrong is worse than a dashboard that fails its own unit test.
 */
export function defineWidgetRegistry<Ctx>(
  widgets: ReadonlyArray<WidgetDefinition<Ctx>>,
): ReadonlyArray<WidgetDefinition<Ctx>> {
  const seenIds = new Set<string>()
  const seenOrders = new Map<number, string>()

  for (const widget of widgets) {
    if (!widget.id.trim()) {
      throw new WidgetRegistryError('a widget was registered with an empty id')
    }
    if (seenIds.has(widget.id)) {
      throw new WidgetRegistryError(`duplicate widget id "${widget.id}" — ids are preference keys and must be unique`)
    }
    if (RETIRED_WIDGET_IDS.includes(widget.id)) {
      throw new WidgetRegistryError(
        `widget id "${widget.id}" is retired and must not be reused — a saved hide for it would apply to unrelated content`,
      )
    }
    if (widget.roles.length === 0) {
      throw new WidgetRegistryError(`widget "${widget.id}" is visible to no role, which is a mistake rather than a configuration`)
    }
    if (widget.minSpan && SPAN_COLUMNS[widget.minSpan] > SPAN_COLUMNS[widget.span]) {
      throw new WidgetRegistryError(
        `widget "${widget.id}" declares minSpan ${widget.minSpan} wider than span ${widget.span}; the resolver would silently widen it`,
      )
    }
    if (widget.criticality === 'critical' && !widget.defaultVisible) {
      throw new WidgetRegistryError(`critical widget "${widget.id}" cannot default to hidden`)
    }
    const clash = seenOrders.get(widget.order)
    if (clash !== undefined) {
      throw new WidgetRegistryError(
        `widgets "${clash}" and "${widget.id}" share order ${widget.order}; ties would resolve by array position and drift on the next edit`,
      )
    }
    seenIds.add(widget.id)
    seenOrders.set(widget.order, widget.id)
  }

  return Object.freeze([...widgets].sort((a, b) => a.order - b.order))
}

export interface WidgetEligibilityInput {
  role: OrganizationRole
  /** Capabilities that have shipped for this workspace. Anything absent gates its widgets out. */
  available: ReadonlySet<WidgetDependency>
  /**
   * Widget ids the user chose to hide. Ignored for `critical` widgets, and ids that are unknown or
   * retired are dropped rather than treated as an error — a preference outliving its widget is
   * expected, not exceptional.
   */
  hidden?: ReadonlySet<string>
}

export interface EligibleWidget<Ctx> {
  widget: WidgetDefinition<Ctx>
}

export interface OmittedWidget {
  id: string
  reason: WidgetOmissionReason
}

export interface ResolvedRegistry<Ctx> {
  /** In render order. This sequence is the DOM order and therefore the focus order. */
  visible: ReadonlyArray<WidgetDefinition<Ctx>>
  /** Why each non-rendered widget is absent — the input to the "restore widget" affordance. */
  omitted: ReadonlyArray<OmittedWidget>
}

/**
 * Resolves a registry for one viewer.
 *
 * Reasons are checked in a fixed order — role, then dependency, then preference — because the answer
 * shown to the user differs. "You cannot see this" must never be presented as "you hid this", and
 * offering to restore a widget the role may not see would confirm it exists.
 */
export function orderedWidgets<Ctx>(
  registry: ReadonlyArray<WidgetDefinition<Ctx>>,
  input: WidgetEligibilityInput,
): ResolvedRegistry<Ctx> {
  const visible: Array<WidgetDefinition<Ctx>> = []
  const omitted: OmittedWidget[] = []

  for (const widget of registry) {
    if (!widget.roles.includes(input.role)) {
      omitted.push({ id: widget.id, reason: 'role' })
      continue
    }
    const missingDependency = widget.dependsOn?.some((dependency) => !input.available.has(dependency)) ?? false
    if (missingDependency) {
      omitted.push({ id: widget.id, reason: 'dependency' })
      continue
    }
    // Criticality wins over preference, and over the default: a payment failure or a security notice
    // is not something a workspace gets to switch off, so `critical` short-circuits both checks.
    if (widget.criticality !== 'critical') {
      if (input.hidden?.has(widget.id) || !widget.defaultVisible) {
        omitted.push({ id: widget.id, reason: 'hidden' })
        continue
      }
    }
    visible.push(widget)
  }

  return { visible, omitted }
}

/**
 * Total columns the visible widgets occupy at `xl`.
 *
 * A total that is not a multiple of 12 means the last band leaves a trailing gap — which, without
 * dense backfill, now stays a gap. The existing `xlColumnsUsed` measures a *resolved layout*; this
 * measures the registry, so a span mistake is caught by a unit test instead of by a hole on a page.
 */
export function registryColumnsUsed<Ctx>(widgets: ReadonlyArray<WidgetDefinition<Ctx>>): number {
  return widgets.reduce((total, widget) => total + SPAN_COLUMNS[widget.span as BentoSpan], 0)
}
