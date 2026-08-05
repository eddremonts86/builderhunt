/**
 * Widget state and eligibility contracts (plans/ui-dashboard Wave 0, "Distinguish every widget state"
 * and "Define a stable typed widget registry").
 *
 * ## The problem these types exist to make unrepresentable
 *
 * Every dashboard widget currently receives plain arrays. `RecommendationsSection` gets
 * `recommendations`, `AlertsWidget` gets `triggers`, and each one renders its own "nothing here"
 * copy when the array is empty. That collapses two facts a user needs to tell apart:
 *
 * - **empty** — the workspace genuinely has no alerts, and the right response is to set one up;
 * - **unavailable** — the request failed and we do not know whether there are alerts.
 *
 * The page currently produces both by catching a failed fetch and falling back to `[]`, so a broken
 * alerts endpoint looks exactly like a calm week. The spec calls this out as structural problem 2
 * ("Failures look empty"), and it is the same class of defect as the search connectors reporting
 * `ok, 0 results` for an upstream returning 403 — a caught error becoming an honest-looking zero.
 *
 * A `WidgetState` is therefore a discriminated union with no "just an array" member. A widget cannot
 * render its content without having been handed `kind: 'ready'` or `kind: 'stale'`, and those are the
 * only two members that carry data.
 */

import type { ReactNode } from 'react'
import type { BentoSpan } from '~/modules/dashboard/ui/bento/layout'
import type { OrganizationRole } from '~/shared/lib/authorization/permissions'

/**
 * How much the product insists a widget be seen.
 *
 * `critical` widgets cannot be hidden or reordered by a user: a payment failure, a security notice, or
 * a blocked workflow is not a preference. Everything else can be, which is what Wave 6 personalizes.
 */
export type WidgetCriticality = 'critical' | 'standard' | 'optional'

/**
 * A capability a widget needs before it can say anything true.
 *
 * These are *product* dependencies, not runtime health: `pipeline` means the hiring-pipeline Kanban
 * has shipped, not that its API answered this request. A widget whose dependency is absent is omitted
 * from the layout entirely rather than rendered empty, because an empty "Pipeline snapshot" implies a
 * pipeline with nothing in it.
 */
export type WidgetDependency =
  | 'pipeline'
  | 'saved-search-health'
  | 'shortlists'
  | 'invitations'
  | 'calendar'
  | 'team-activity'
  | 'source-coverage'

/**
 * Why a widget is not showing its content.
 *
 * Separate from `WidgetState` so the reason survives serialization: the server decides eligibility and
 * the browser renders it, and "you may not see this" must not be inferred from an absent field.
 */
export type WidgetOmissionReason =
  /** The role is not eligible. The frame renders nothing at all — see the note on `forbidden` below. */
  | 'role'
  /** A `WidgetDependency` has not shipped for this workspace. */
  | 'dependency'
  /** The user hid it. Only possible for non-critical widgets. */
  | 'hidden'

/**
 * What a widget is currently able to show.
 *
 * `ready` and `stale` both carry data and differ only in freshness, so a widget body is written once
 * against `data` and the frame decides whether to caption it. The rest carry no data at all, which is
 * the point: there is no way to render a list from an `unavailable` state.
 */
export type WidgetState<T> =
  /** First load, or a refetch with nothing cached. */
  | { kind: 'loading' }
  /** Data, fresh enough to present without qualification. */
  | { kind: 'ready'; data: T; generatedAt: string }
  /**
   * Data older than the widget's freshness budget — a cache hit past its TTL, or a projection whose
   * `generatedAt` has aged. Shown, and captioned as of its timestamp. Never silently presented as
   * current: an aggregate with no time is a claim about now.
   */
  | { kind: 'stale'; data: T; generatedAt: string; reason: 'cache' | 'upstream' }
  /**
   * The query succeeded and the answer is nothing. Distinct from every failure below, and the only
   * state whose copy may suggest what to create.
   */
  | { kind: 'empty' }
  /**
   * Some of the widget's inputs answered and some did not. Renders what arrived plus a named account
   * of what is missing — never a total that silently omits a failed component.
   */
  | { kind: 'partial'; data: T; generatedAt: string; missing: readonly string[] }
  /**
   * Failed, and retrying is worth offering. The frame renders the retry control; the widget never
   * owns it, so every widget's retry looks and behaves the same.
   */
  | { kind: 'error'; retryable: true }
  /**
   * Failed, and retrying will not help — a disabled capability, an unconfigured integration, a
   * dependency that is down. Carries a short operator-safe code, never a configuration value, a
   * provider message, or a URL.
   */
  | { kind: 'unavailable'; code: string }
  /**
   * The signed-in role may not see this widget's data.
   *
   * Rendering a "you do not have access" tile is itself a disclosure — it confirms the workspace has
   * the thing. The frame renders **nothing**, and this member exists so the *layout* can tell a
   * forbidden widget from an absent one when reconciling saved preferences against a role change.
   */
  | { kind: 'forbidden' }

/** The states that carry data. Kept as a guard so widget bodies narrow in one call. */
export function hasWidgetData<T>(
  state: WidgetState<T>,
): state is Extract<WidgetState<T>, { data: T }> {
  return state.kind === 'ready' || state.kind === 'stale' || state.kind === 'partial'
}

/** The states that render no body at all, so the layout can drop the tile rather than paint a box. */
export function isWidgetOmitted<T>(state: WidgetState<T>): boolean {
  return state.kind === 'forbidden'
}

/**
 * One widget's registration.
 *
 * Deliberately data, not components: `render` is the only function, and everything the layout,
 * preferences and tests need to reason about is a plain value. A registry of components would make
 * "which widgets does an admin see in a workspace without a pipeline?" a rendering question.
 */
export interface WidgetDefinition<Ctx> {
  /**
   * Stable, and stable *forever*. It is the preference key, the `data-widget` test hook and the
   * analytics label, so renaming one silently resets every user's layout. Retiring a widget means
   * adding its id to `RETIRED_WIDGET_IDS`, not deleting the string.
   */
  id: string
  /** Accessible name for the tile's region and heading. */
  title: string
  criticality: WidgetCriticality
  /**
   * Roles that may see it. An empty list is rejected at registry construction — a widget nobody can
   * see is a mistake, not a configuration.
   */
  roles: readonly OrganizationRole[]
  /** Capabilities that must have shipped. Absent means the widget stands alone. */
  dependsOn?: readonly WidgetDependency[]
  /**
   * Position in the single ordered sequence. Lower is earlier, and the sequence is the DOM order, the
   * focus order and the visual order — see `orderedWidgets`.
   */
  order: number
  /** Whether a workspace that has expressed no preference sees it. */
  defaultVisible: boolean
  span: BentoSpan
  /** Narrowest span at which the content is still readable; the resolver refuses to go under it. */
  minSpan?: BentoSpan
  /** Merged into one full-width tile per group in `sections` density. */
  sectionGroup?: string
  render: (ctx: Ctx) => ReactNode
}

/**
 * Widget ids that once existed and must never be reused or re-registered.
 *
 * A saved preference referencing one of these is dropped silently on read — the user hid a widget
 * that no longer exists, which is not an error worth surfacing. Reusing the string for a *different*
 * widget would instead resurrect that hide against unrelated content, which is why the list is
 * enforced rather than documented.
 */
export const RETIRED_WIDGET_IDS: readonly string[] = [
  // Removed from the default dashboard 2026-08-06: a count of private notes answers no question and
  // continues nowhere (plans/ui-dashboard spec, "Current widget disposition").
  'stat-notes',
]
