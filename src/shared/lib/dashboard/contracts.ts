import { z } from 'zod'

/**
 * The wire contract for `GET /api/dashboard/overview` (plans/ui-dashboard Wave 1, "Define versioned
 * dashboard overview contracts").
 *
 * One module, parsed on both sides. The route validates what it is about to send and the browser
 * validates what it received, against the same schemas — so a section that drifts is caught at the
 * boundary rather than three components deep, and a client built against an older shape refuses the
 * payload instead of rendering a plausible guess from it.
 *
 * ## Four properties this shape exists to guarantee
 *
 * **1. Sections fail independently.** Every section is an envelope with its own status and its own
 * `generatedAt`. The page it replaces made seven fetches, four of them ending in `.catch(() => [])`,
 * so a failed request became an empty array and an empty array became "nothing here yet". A reader
 * could not tell a quiet workspace from a broken one. Here there is no way to express "this section
 * failed" as data: `unavailable` carries no rows at all.
 *
 * **2. Freshness is mandatory, not optional.** `generatedAt` is required on every section that
 * carries data. An aggregate rendered without a time is a claim about *now*, and a cached projection
 * silently makes that claim false. Parsing fails when it is missing rather than defaulting to the
 * current time, because a default would manufacture exactly the reassurance that is wrong.
 *
 * **3. The server never sends a URL.** An action is `{ kind, resourceId }` drawn from a closed
 * allowlist, and the browser maps the kind through its own typed route registry. A server-supplied
 * `href` rendered into an anchor is one injection away from being an open redirect, and this
 * projection assembles rows from tenant data.
 *
 * **4. Rows are bounded at the schema.** Every list has a maximum length and exceeding it is a parse
 * error, not a truncation. A truncating parser turns "this organization has 40 000 alerts and the
 * query forgot its LIMIT" into a page that looks fine.
 */

/**
 * Bumped when a change would make an older client misread a payload — a removed field, a narrowed
 * enum, a changed unit. Adding an optional field does not qualify.
 *
 * The client compares exactly and refuses a mismatch. Not "greater than or equal": a *newer* server
 * is the case where a removed field would be silently absent, which is precisely the mismatch worth
 * refusing.
 */
export const DASHBOARD_SCHEMA_VERSION = 1

export const DASHBOARD_RANGES = ['24h', '7d', '30d'] as const
export type DashboardRange = (typeof DASHBOARD_RANGES)[number]
export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '7d'

/** Rejects an unknown range rather than silently falling back — a wrong window is a wrong number. */
export const dashboardRangeSchema = z.enum(DASHBOARD_RANGES)

/**
 * Every action the queue may ask the browser to offer.
 *
 * Closed on purpose. Adding a kind means adding a route mapping in the same commit, so a server that
 * learns a new action before the client can render it degrades to "no action" rather than to a dead
 * control or an arbitrary link.
 */
export const DASHBOARD_ACTION_KINDS = [
  'open-billing',
  'open-interview',
  'open-calendar',
  'open-availability',
  'open-invitation',
  'open-alert',
  'open-sprint',
  'open-saved-search',
  'open-builder',
  'open-team',
  'open-onboarding',
  'open-search',
] as const
export type DashboardActionKind = (typeof DASHBOARD_ACTION_KINDS)[number]

/**
 * A continuation, as a kind plus an opaque id. Never a path, never a query string.
 *
 * `resourceId` is constrained to the shape of the ids this product mints — `randomId()` output, a
 * UUID, or a slug — so a value that could traverse a path or carry a scheme cannot reach the route
 * builder even if a repository is one day careless about what it selects.
 */
export const dashboardActionSchema = z.object({
  kind: z.enum(DASHBOARD_ACTION_KINDS),
  resourceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).nullable(),
})
export type DashboardAction = z.infer<typeof dashboardActionSchema>

/** Ordering severity for anything the user is being asked to deal with. */
export const DASHBOARD_SEVERITIES = ['critical', 'warning', 'info'] as const
export type DashboardSeverity = (typeof DASHBOARD_SEVERITIES)[number]

/**
 * Why a section carries no data.
 *
 * `forbidden` is deliberately indistinguishable from an omitted section on the wire — the key is
 * simply absent, and the client's registry already knows the role is ineligible. Sending
 * `{status: 'forbidden'}` for Billing would confirm to a member that the workspace has billing,
 * which is the disclosure omitting it was meant to prevent.
 */
export const DASHBOARD_SECTION_UNAVAILABLE_CODES = [
  'section_failed',
  'dependency_unavailable',
  'range_unsupported',
] as const
export type DashboardSectionUnavailableCode = (typeof DASHBOARD_SECTION_UNAVAILABLE_CODES)[number]

const generatedAt = z.iso.datetime()

/**
 * Wraps one section's payload.
 *
 * `empty` still carries `generatedAt`: "we looked at 03:14 and there was nothing" is a different and
 * more useful statement than "there is nothing", and it is what lets a stale cache be labelled.
 */
function sectionEnvelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), generatedAt, data }),
    z.object({ status: z.literal('empty'), generatedAt }),
    z.object({
      status: z.literal('unavailable'),
      code: z.enum(DASHBOARD_SECTION_UNAVAILABLE_CODES),
    }),
  ])
}

/** Caps, applied at parse time. Exceeding one is a contract violation, not something to trim. */
export const DASHBOARD_ROW_LIMITS = {
  actionQueue: 12,
  savedSearches: 10,
  recentBuilders: 12,
  sprints: 8,
  alerts: 10,
  sourceCoverage: 16,
  recencyBuckets: 31,
  /** A week's agenda, bounded. Past six rows the widget is a calendar and should link to one. */
  upcoming: 6,
  /** A review queue nobody finishes is not a queue. Six is a sitting, not a backlog. */
  review: 6,
  shortlists: 5,
  /** Recent, not paginated. The full log lives on `/team/activity`. */
  activity: 5,
} as const

// ── Sections ──────────────────────────────────────────────────────────────────────────────────

export const dashboardSummarySchema = z.object({
  /** Everything the workspace tracks, all time. */
  trackedBuilders: z.number().int().nonnegative(),
  /**
   * Tracked builders a connector last observed inside the range. A recency fact — it counts people,
   * not events, which is what the column supports and what the copy must say.
   */
  seenActiveInRange: z.number().int().nonnegative(),
  /** Tracked for the first time inside the range. Disjoint from the above by definition. */
  newlyTrackedInRange: z.number().int().nonnegative(),
  savedSearches: z.number().int().nonnegative(),
})
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>

export const dashboardRecencySchema = z.object({
  /** One bucket per day of the range. Each tracked builder falls in exactly one. */
  buckets: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().nonnegative(),
  })).max(DASHBOARD_ROW_LIMITS.recencyBuckets),
  /** Stated rather than inferred from the bucket keys, which say nothing about the boundary rule. */
  timezone: z.literal('UTC'),
})
export type DashboardRecency = z.infer<typeof dashboardRecencySchema>

export const dashboardActionItemSchema = z.object({
  /**
   * A composite: `<ruleId>:<resourceKey>`, stable across requests for the same underlying problem so
   * a client can key a list on it and telemetry can correlate a resolution without the resource id.
   *
   * Bounded at 128 rather than the 64 used for `resourceId`, because it is two identifiers and a
   * separator, not one. It was 64, and `interview-missing-brief:interview:<uuid>` is 70 — the
   * outbound validation caught it and refused the whole response, which is the cap doing its job at
   * the cost of a 500 the first time a real rule met a real uuid.
   */
  id: z.string().min(1).max(128),
  severity: z.enum(DASHBOARD_SEVERITIES),
  /** Short, already-resolved text. Never a template the client has to fill from other fields. */
  title: z.string().min(1).max(120),
  detail: z.string().max(200).nullable(),
  /** When the thing is due or started, so the queue can order by time within a severity. */
  dueAt: z.iso.datetime().nullable(),
  action: dashboardActionSchema,
})
export type DashboardActionItem = z.infer<typeof dashboardActionItemSchema>

export const dashboardSourceCoverageSchema = z.object({
  /** Counted across every tracked builder, not a recent sample. That distinction is the widget. */
  sources: z.array(z.object({
    source: z.string().min(1).max(32),
    count: z.number().int().nonnegative(),
  })).max(DASHBOARD_ROW_LIMITS.sourceCoverage),
  /** The denominator, sent explicitly so no client has to sum the rows and get it subtly wrong. */
  totalTracked: z.number().int().nonnegative(),
})
export type DashboardSourceCoverage = z.infer<typeof dashboardSourceCoverageSchema>

/**
 * One row of the today-and-upcoming agenda.
 *
 * Instants, not display strings. The server knows the event's own IANA zone and sends it alongside,
 * so the widget can say "14:00 Europe/Copenhagen" to a viewer in another zone without the server
 * having to guess which zone that is. Formatting on the server would bake in a locale the request
 * never carried.
 */
export const dashboardUpcomingItemSchema = z.object({
  eventId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().min(1).max(200),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().min(1).max(64),
  allDay: z.boolean(),
  /** The event's own type, never inferred from its title. */
  type: z.string().min(1).max(32),
  location: z.string().max(200).nullable(),
  /**
   * Validated as an absolute http(s) URL here rather than trusted at render time. It is the one
   * field in this projection that a user typed and that the browser will follow, so `javascript:`,
   * a protocol-relative `//evil.test`, and anything else that is not a fetchable meeting link is
   * refused at the boundary instead of being sanitised in each component that shows it.
   */
  meetingUrl: z.url({ protocol: /^https?$/ }).max(500).nullable(),
  /**
   * Whether an *active* interview brief exists. A draft or superseded brief counts as absent,
   * because the question the dashboard asks is "am I walking into this unprepared".
   */
  hasActiveBrief: z.boolean(),
  invitationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).nullable(),
})
export type DashboardUpcomingItem = z.infer<typeof dashboardUpcomingItemSchema>

/** Where a review candidate came from. Rendered as the row's reason, never inferred by the client. */
export const DASHBOARD_REVIEW_PROVENANCE = ['alert-match', 'sprint-result'] as const

export const dashboardReviewItemSchema = z.object({
  /** `<source>:<sourceId>`. The identity the projection deduplicated on, and the React key. */
  key: z.string().min(1).max(128),
  source: z.string().min(1).max(32),
  username: z.string().min(1).max(120),
  displayName: z.string().max(200).nullable(),
  provenance: z.enum(DASHBOARD_REVIEW_PROVENANCE),
  /** Already-resolved text. A row that cannot say why it is here does not belong in a review queue. */
  reason: z.string().min(1).max(160),
  score: z.number().int().nullable(),
  tracked: z.boolean(),
  /**
   * Present only when tracked. It is what decides the continuation: a tracked person opens in the
   * internal builder workspace, an untracked one has no internal page to open yet.
   */
  organizationBuilderId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).nullable(),
})
export type DashboardReviewItem = z.infer<typeof dashboardReviewItemSchema>

export const dashboardShortlistSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  /**
   * `private` or `organization`. Rendered as a badge, because a shortlist is a list of people
   * someone is considering and whether a colleague can see it is the first thing its owner needs to
   * know at a glance.
   */
  visibility: z.enum(['private', 'organization']),
  itemCount: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
})
export type DashboardShortlist = z.infer<typeof dashboardShortlistSchema>

/**
 * Interview invitations by state.
 *
 * A distribution, not a funnel. The seven states are the table's own CHECK list and they are not a
 * pipeline: `expired` and `revoked` are terminal, `declined` is an answer rather than a failure, and
 * an invitation can reach `booked` without ever being recorded as `opened`. Sending percentages
 * would invite a conversion rate computed from a denominator that does not mean what it looks like.
 */
export const dashboardInvitationDistributionSchema = z.object({
  /** Every status, always, including the zeros — an omitted category changes the shape's meaning. */
  counts: z.array(z.object({
    status: z.enum(['draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked']),
    count: z.number().int().nonnegative(),
  })).length(7),
  /** `declined` + `expired`: the two waiting on the organizer rather than on the candidate. */
  needsAction: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})
export type DashboardInvitationDistribution = z.infer<typeof dashboardInvitationDistributionSchema>

/**
 * One line of team activity.
 *
 * The server sends **resolved text**, not a template plus ids for the client to interpolate. Two
 * reasons: the formatting rules already live server-side in `ACTIVITY_EVENTS`, so a second copy in
 * the browser is a second thing to keep in step with every new event type; and `metadata` carries
 * ids and free text that have no business crossing the wire when the sentence is all a reader needs.
 *
 * `actorDisplayName` is nullable and that is meaningful: `null` is "unknown or no longer a member",
 * which the UI renders as *Former member* rather than as a blank or a raw user id.
 *
 * There is no count and no rate. The plan is explicit that event volume must not be framed as
 * employee performance, and the cheapest way to honour that is to send nothing anyone could chart.
 */
export const dashboardActivityItemSchema = z.object({
  id: z.string().min(1).max(64),
  /** Already-formatted, already-redacted. */
  display: z.string().min(1).max(200),
  actorDisplayName: z.string().max(120).nullable(),
  occurredAt: z.iso.datetime(),
  /**
   * A same-origin path this app owns, or null. Resolved server-side against the real row, so a
   * deleted or inaccessible target arrives as plain text rather than as a link to a 404.
   */
  targetHref: z.string().max(200).regex(/^\/[A-Za-z0-9/_\-?=&.]*$/).nullable(),
})
export type DashboardActivityItem = z.infer<typeof dashboardActivityItemSchema>

/**
 * The role-minimized usage view.
 *
 * Minimized by the **server**, from the principal's role — never by the client hiding fields it was
 * sent. `seats` and `credits` are present only for a role the canonical billing policy allows to see
 * them, so a member's payload does not contain the numbers at all.
 */
export const dashboardUsageSchema = z.object({
  tier: z.string().min(1).max(32),
  paidActionsAllowed: z.boolean(),
  seats: z.object({
    used: z.number().int().nonnegative(),
    allowed: z.number().int().nonnegative(),
  }).nullable(),
  creditBalanceUnits: z.number().int().nullable(),
  /** A dated, already-evaluated warning. The client does not re-derive thresholds. */
  warning: z.object({
    severity: z.enum(DASHBOARD_SEVERITIES),
    message: z.string().min(1).max(160),
  }).nullable(),
})
export type DashboardUsage = z.infer<typeof dashboardUsageSchema>

/**
 * Below this many views in the window, the server sends no number at all.
 *
 * Not a rounding rule — the count genuinely does not cross the wire. A floor that transmits the
 * small number and asks the client to hide it is a floor that leaks the moment anyone reads a
 * response body, and the response body is the one place a privacy promise has to hold.
 *
 * Five, for two reasons that agree. A profile owner who sees "2 views" beside an approach they
 * received the same morning is one inference from naming the person who looked — and this is a
 * glanceable tile, not the dated series on `/me` where a small number reads as what it is. And below
 * a handful there is no trend to summarise: reporting "3" as a 30-day figure dresses an anecdote as a
 * measurement.
 */
export const PROFILE_VIEW_COHORT_FLOOR = 5

/**
 * The verified-profile-owner summary (plans/ui-dashboard Wave 5).
 *
 * Present only for a user who holds a **verified** claim on a builder identity. Absent — the whole
 * section key missing, exactly like `usage` for a non-billing role — for everybody else, which is the
 * same reasoning the `forbidden` note above gives: an `unavailable` status would confirm that the
 * feature applies to this account, and the point is that it discloses nothing.
 *
 * Two publication states, not one, because the codebase keeps them independent and conflating them
 * would misreport both: `directoryPublished` is a `published_builder_profiles` row, the public
 * directory listing; `portfolioPublished` is the portfolio builder's own flag. A profile can be
 * either without the other.
 */
export const dashboardProfileOwnerSchema = z.object({
  builderId: z.string().min(1).max(64),
  directoryPublished: z.boolean(),
  portfolioPublished: z.boolean(),
  windowDays: z.number().int().positive().max(365),
  /**
   * How many people looked, or `null` for "fewer than the floor".
   *
   * `null` is unambiguous here, which is the only reason a bare nullable is enough: a section that
   * could not be read is `unavailable` at the envelope, so inside a `ready` payload there is exactly
   * one thing an absent count can mean. A discriminated union would restate what the envelope already
   * says — and, tried first, it also pushed `SectionData<K>` past TypeScript's union-complexity limit,
   * which is the type system noticing the same redundancy.
   */
  viewsInWindow: z.number().int().nonnegative().nullable(),
})
export type DashboardProfileOwner = z.infer<typeof dashboardProfileOwnerSchema>

// ── The response ──────────────────────────────────────────────────────────────────────────────

export const dashboardOverviewSchema = z.object({
  schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
  /**
   * Which tenant these numbers describe. The client asserts it against the session's active
   * organization before rendering: an organization switch that races a slow response must never
   * paint the previous tenant's figures under the new tenant's name.
   */
  organizationId: z.string().min(1).max(64),
  range: dashboardRangeSchema,
  /** When the response as a whole was assembled. Per-section times may be older on a cache hit. */
  generatedAt,
  sections: z.object({
    summary: sectionEnvelope(dashboardSummarySchema),
    recency: sectionEnvelope(dashboardRecencySchema),
    actionQueue: sectionEnvelope(
      z.object({ items: z.array(dashboardActionItemSchema).max(DASHBOARD_ROW_LIMITS.actionQueue) }),
    ),
    sourceCoverage: sectionEnvelope(dashboardSourceCoverageSchema),
    upcoming: sectionEnvelope(
      z.object({ items: z.array(dashboardUpcomingItemSchema).max(DASHBOARD_ROW_LIMITS.upcoming) }),
    ),
    review: sectionEnvelope(
      z.object({ items: z.array(dashboardReviewItemSchema).max(DASHBOARD_ROW_LIMITS.review) }),
    ),
    /*
     * Both reuse `dashboardRecencySchema` — the same `{ buckets, timezone }` shape — because they are
     * the same *kind* of thing rendered by the same primitive. What differs is entirely in the copy,
     * and the copy is the part that has to be right: recency is a distribution over the roster,
     * discovery is a rate of arrivals, and alert volume counts events. Three charts, one wire shape,
     * three sentences that must not be swapped.
     */
    shortlists: sectionEnvelope(
      z.object({ items: z.array(dashboardShortlistSchema).max(DASHBOARD_ROW_LIMITS.shortlists) }),
    ),
    invitations: sectionEnvelope(dashboardInvitationDistributionSchema),
    activity: sectionEnvelope(
      z.object({ items: z.array(dashboardActivityItemSchema).max(DASHBOARD_ROW_LIMITS.activity) }),
    ),
    discoveryTrend: sectionEnvelope(dashboardRecencySchema),
    alertVolume: sectionEnvelope(dashboardRecencySchema),
    // Absent entirely for a role that may not see it — see the note on `forbidden` above.
    usage: sectionEnvelope(dashboardUsageSchema).optional(),
    // Absent entirely for anyone without a verified builder claim, same reasoning.
    profileOwner: sectionEnvelope(dashboardProfileOwnerSchema).optional(),
  }),
})
export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>
export type DashboardSections = DashboardOverview['sections']
export type DashboardSectionId = keyof DashboardSections

/**
 * Parses a response, refusing anything it cannot read exactly.
 *
 * Returns a discriminated result rather than throwing: the caller has to render *something*, and the
 * something for "the server sent a shape I do not understand" is an error state on the whole page —
 * not a crash, and definitely not a partially-populated dashboard assembled from whichever fields
 * happened to survive.
 */
export function parseDashboardOverview(
  input: unknown,
): { ok: true; overview: DashboardOverview } | { ok: false; reason: 'schema' | 'version' } {
  // Checked before full validation so an incompatible deploy reports the actual cause rather than a
  // pile of field errors that all descend from it.
  if (typeof input === 'object' && input !== null && 'schemaVersion' in input) {
    const version = (input as { schemaVersion: unknown }).schemaVersion
    if (version !== DASHBOARD_SCHEMA_VERSION) return { ok: false, reason: 'version' }
  }
  const parsed = dashboardOverviewSchema.safeParse(input)
  return parsed.success ? { ok: true, overview: parsed.data } : { ok: false, reason: 'schema' }
}
