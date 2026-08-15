/**
 * What the dashboard needs to know before it composes itself (plan:
 * phase-2/04-dashboard-personalizado).
 *
 * ## Why a context endpoint rather than a per-segment dashboard endpoint
 *
 * The spec is explicit that there must be no giant per-segment endpoint. This one answers *which
 * route*, and the widgets keep reading the sources they already read — so a preset changes the
 * order of the page and nothing about what it fetches.
 *
 * ## What it may say
 *
 * The caller's own segment, the route it resolves to, the role they hold, the capabilities this
 * deployment has shipped, and their plan. Nothing about another person and nothing about another
 * workspace: every field is something the caller could already read from a surface they have.
 *
 * ## Why the plan is in here at all
 *
 * So the dashboard can say "that is on another plan" instead of hiding a widget. A preset must not
 * become a second entitlement surface — hiding `alerts` from a free workspace tells somebody the
 * feature does not exist, which is a different message from the true one. Presets decide order;
 * this field lets the page be honest about the rest.
 */
import { z } from 'zod'
import { SEGMENT_PRESETS, userSegmentSchema } from './user-segments'

/** Capabilities a widget can depend on. Mirrors `WidgetDependency` — see the note on the schema. */
export const DASHBOARD_CAPABILITIES = [
  'pipeline',
  'saved-search-health',
  'shortlists',
  'invitations',
  'calendar',
  'team-activity',
  'source-coverage',
] as const
export type DashboardCapability = (typeof DASHBOARD_CAPABILITIES)[number]

/**
 * The capabilities this deployment actually has.
 *
 * `pipeline` and `saved-search-health` are named in the dashboard spec and do not exist, so any
 * widget declaring them is omitted rather than rendered empty — an empty "Pipeline snapshot"
 * implies a pipeline with nothing in it.
 *
 * Served rather than only compiled in, because "has this shipped" is a fact about the deployment
 * answering the request. A client that decided it alone would keep its answer through a rollback.
 */
export const SHIPPED_DASHBOARD_CAPABILITIES: readonly DashboardCapability[] = [
  'shortlists',
  'invitations',
  'calendar',
  'team-activity',
  'source-coverage',
]

export const dashboardContextSchema = z.object({
  /** What the person chose. `null` is the common case and is not a failure. */
  segment: userSegmentSchema.nullable(),
  /** The route that resolves to — `general` for a null segment and for anything unrecognised. */
  presetId: z.enum(SEGMENT_PRESETS),
  role: z.enum(['owner', 'admin', 'member']),
  capabilities: z.array(z.enum(DASHBOARD_CAPABILITIES)),
  entitlement: z.object({
    tier: z.enum(['free', 'pro', 'pro_max', 'team']),
    /** Whether paid actions are allowed at all — the honest input to "that is on another plan". */
    paidActionsAllowed: z.boolean(),
  }),
}).strict()

export type DashboardContext = z.infer<typeof dashboardContextSchema>

/**
 * What the page assumes before the request lands, and what it falls back to when it fails.
 *
 * `general`, the role with the least to see, and the capabilities compiled into this build. A
 * dashboard that could not render because a preference did not load would be a worse product than
 * one that renders the layout everybody already has.
 */
export const DEFAULT_DASHBOARD_CONTEXT: DashboardContext = {
  segment: null,
  presetId: 'general',
  role: 'member',
  capabilities: [...SHIPPED_DASHBOARD_CAPABILITIES],
  entitlement: { tier: 'free', paidActionsAllowed: false },
}
