import { z } from 'zod'

/**
 * The wire contract for the Admin Metrics sections (plan 57, Admin track — "Define versioned Admin
 * Metrics section contracts").
 *
 * Same shape and the same four properties as `shared/lib/dashboard/contracts.ts`: one module parsed on
 * both sides, sections that fail independently, mandatory freshness, no server-supplied URLs, and rows
 * bounded at the schema rather than trimmed. Read that file's header for the reasoning; it is not
 * repeated here.
 *
 * What this file adds is the part specific to *operator* metrics, and it is one idea: **a number is
 * meaningless without the thing that says how to read it.** An operator page is where a plausible number
 * does the most damage, because the whole point of it is to be believed at 02:00. So four things are
 * mandatory on anything numeric, and the parser refuses a payload that omits them:
 *
 * - **a unit** — `1500` is fifteen hundred requests, or one and a half seconds, or 1.5 KB;
 * - **a scope** — see the note on `MetricScope`, which is the one that this product has already been
 *   bitten by;
 * - **a window** with a timezone — "errors: 42" over an unstated period is not a measurement;
 * - **a `generatedAt`** — an aggregate rendered without a time is a claim about *now*.
 *
 * ## The scope rule, and the bug it exists for
 *
 * `metrics.get()` returns in-process counters. They start at zero when the process starts, they are
 * per-instance, and a deploy resets them. `/api/admin/metrics` names that block `inProcess` precisely so
 * nobody reads it as a platform total — the counters answer "what has this instance seen since it
 * booted", which for a multi-instance deployment is a fraction of the truth and after a deploy is
 * almost none of it.
 *
 * The schema makes that impossible to get wrong rather than a naming convention somebody has to
 * remember. A `process`-scoped metric **must** carry the process identity it came from, and **may not**
 * be flagged as a platform total. `platformTotal: true` with `scope: 'process'` is a parse error, which
 * is the exact sentence "this instance's counter is the platform's number" — the one an operator would
 * act on and be wrong.
 */

/**
 * Bumped when a change would make an older client misread a payload — a removed field, a narrowed enum,
 * a changed unit. Adding an optional field does not qualify.
 *
 * Separate from `DASHBOARD_SCHEMA_VERSION` on purpose: the two surfaces ship independently, and one
 * shared number would force a client refresh on the tenant dashboard because an admin section changed.
 */
export const ADMIN_METRICS_SCHEMA_VERSION = 1

/**
 * The sections. Each loads on its own request, so this is also the routing vocabulary.
 *
 * `operations` was added 2026-08-11 for the Command Center's worker and integration health, and adding a member
 * here is deliberately **not** a `ADMIN_METRICS_SCHEMA_VERSION` bump: a client only requests sections it knows
 * about, so an older one cannot misread an existing payload — it simply never asks for the new tab. The version
 * exists for changes that make an old client read a *wrong* value, and this is not one.
 */
export const ADMIN_METRIC_SECTIONS = [
  'overview',
  'traffic',
  'search',
  'discovery',
  'activation',
  'conversion',
  'reliability',
  'operations',
  'runtime',
] as const
export type AdminMetricSection = (typeof ADMIN_METRIC_SECTIONS)[number]

/**
 * Windows an operator may ask for, and nothing else.
 *
 * Closed rather than a free `from`/`to` pair because an arbitrary window is an arbitrary query: the
 * ranges here are the ones the aggregates have indexes for, and a caller asking for eighteen months
 * would get a sequential scan on the busiest table in the product.
 */
export const ADMIN_METRIC_RANGES = ['1h', '24h', '7d', '30d'] as const
export type AdminMetricRange = (typeof ADMIN_METRIC_RANGES)[number]

/**
 * Presentation variants, allowlisted per section.
 *
 * A variant changes which shape the section returns, so an unknown one cannot be "ignored and
 * defaulted": the client would render the default while its URL says otherwise, and an operator sharing
 * that URL would send somebody to a different view than the one they were looking at.
 */
export const ADMIN_METRIC_VARIANTS_BY_SECTION = {
  overview: ['summary'],
  traffic: ['rate', 'latency', 'errors'],
  search: ['volume', 'quality'],
  discovery: ['coverage', 'throughput'],
  activation: ['funnel', 'cohort'],
  conversion: ['funnel', 'revenue'],
  reliability: ['availability', 'features'],
  /**
   * Two registries, two variants, and they are not the same question.
   *
   * `workers` asks whether the scheduled jobs are running; `integrations` asks whether the source registers
   * describe something that can actually be contacted. Merging them would put "three jobs overdue" beside "two
   * sources enabled with no connector" under one heading, and an operator acting on the first would not think
   * to check the second.
   */
  operations: ['workers', 'integrations'],
  runtime: ['process', 'freshness'],
} as const satisfies Record<AdminMetricSection, readonly [string, ...string[]]>

export type AdminMetricVariant<S extends AdminMetricSection = AdminMetricSection> =
  (typeof ADMIN_METRIC_VARIANTS_BY_SECTION)[S][number]

export function variantsFor(section: AdminMetricSection): readonly string[] {
  return ADMIN_METRIC_VARIANTS_BY_SECTION[section]
}

/** Units. Mandatory on every numeric value, because the number alone does not say which one it is. */
export const METRIC_UNITS = ['count', 'ratio', 'milliseconds', 'bytes', 'per_second'] as const
export type MetricUnit = (typeof METRIC_UNITS)[number]

/**
 * Where a number came from, which decides how far it may be trusted.
 *
 * - `process` — an in-process counter. Per-instance, zero at boot, reset by a deploy. Requires
 *   `processIdentity` and may never be a platform total.
 * - `database` — a persisted aggregate. The only scope that can honestly claim to be platform-wide.
 * - `external` — read from a third party. Carries its own staleness, so `generatedAt` is the time *we*
 *   read it, not the time it was true.
 */
export const METRIC_SCOPES = ['process', 'database', 'external'] as const
export type MetricScope = (typeof METRIC_SCOPES)[number]

export const ADMIN_SECTION_UNAVAILABLE_CODES = [
  'dependency_unavailable',
  'not_enabled',
  'insufficient_history',
  'timeout',
  'error',
] as const

/** Caps, applied at parse time. Exceeding one is a contract violation, not something to trim. */
export const ADMIN_METRIC_LIMITS = {
  /**
   * 90 buckets. Enough for 30 days of three-per-day or 90 days of daily, and small enough that a chart
   * stays readable and a payload stays a payload. A series that wants more wants a different product.
   */
  seriesBuckets: 90,
  /**
   * 10 ranked rows. A ranking an operator has to scroll is not a ranking, and an unbounded "top routes"
   * is how one bad deploy turns a metrics page into a 40 000-row response.
   */
  rankedRows: 10,
} as const

const generatedAt = z.string().datetime({ offset: true })

/**
 * The window a measurement covers, with its timezone.
 *
 * The timezone is required and is not decoration: bucket boundaries for anything daily are a local-time
 * question, and two operators in different places reading "yesterday" off the same payload must be
 * reading the same day.
 */
export const metricWindowSchema = z
  .object({
    range: z.enum(ADMIN_METRIC_RANGES),
    from: generatedAt,
    to: generatedAt,
    timezone: z.string().min(1),
  })
  .refine((w) => new Date(w.from) < new Date(w.to), {
    message: 'window.from must be before window.to',
  })

/** Identifies the instance a `process`-scoped number came from, so two of them are not summed. */
export const processIdentitySchema = z.object({
  pid: z.number().int().positive(),
  /** When this process started, which is when its counters were last zero. */
  startedAt: generatedAt,
  /** Distinguishes instances of the same deployment. */
  instance: z.string().min(1).max(128),
})

/**
 * A threshold pair, validated for direction.
 *
 * `direction` is what makes the pair checkable at all: for a latency metric `warn` must be below
 * `critical`, and for an availability ratio it must be above. Without it the schema can only assert two
 * numbers exist, and a swapped pair — critical at 200 ms, warn at 2 s — would parse and then never fire
 * the alert an operator is relying on.
 */
export const metricThresholdSchema = z
  .object({
    direction: z.enum(['higher_is_worse', 'lower_is_worse']),
    warn: z.number(),
    critical: z.number(),
  })
  .refine(
    (t) => (t.direction === 'higher_is_worse' ? t.warn < t.critical : t.warn > t.critical),
    { message: 'threshold warn/critical are the wrong way round for the stated direction' },
  )

/**
 * One measured value, and everything needed to read it.
 *
 * The `superRefine` is the scope rule from this file's header: a process counter may not claim to be a
 * platform total, and it must say which process it came from.
 */
export const metricValueSchema = z
  .object({
    /** Stable identifier, not a display string — the client owns the label. */
    key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'metric keys are lower_snake_case'),
    value: z.number().finite(),
    unit: z.enum(METRIC_UNITS),
    scope: z.enum(METRIC_SCOPES),
    /** Present only when the number really is the whole platform's. */
    platformTotal: z.boolean().optional(),
    processIdentity: processIdentitySchema.optional(),
    threshold: metricThresholdSchema.optional(),
    /** The same metric one window earlier, for a comparison the client does not have to compute. */
    previous: z.number().finite().optional(),
  })
  .superRefine((metric, ctx) => {
    if (metric.scope === 'process') {
      if (metric.platformTotal === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['platformTotal'],
          message:
            'a process-scoped counter is per-instance and resets on deploy, so it cannot be a platform total',
        })
      }
      if (!metric.processIdentity) {
        ctx.addIssue({
          code: 'custom',
          path: ['processIdentity'],
          message: 'a process-scoped counter must say which process and start time it came from',
        })
      }
    } else if (metric.processIdentity) {
      ctx.addIssue({
        code: 'custom',
        path: ['processIdentity'],
        message: 'only a process-scoped counter carries a process identity',
      })
    }
  })

/** A bounded time series. One unit for the whole series — a chart with mixed units is two charts. */
export const metricSeriesSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  unit: z.enum(METRIC_UNITS),
  scope: z.enum(METRIC_SCOPES),
  buckets: z
    .array(z.object({ at: generatedAt, value: z.number().finite() }))
    .max(ADMIN_METRIC_LIMITS.seriesBuckets),
})

/**
 * The route families a ranking may be broken down by.
 *
 * An allowlist, not a free string, for two reasons. A raw path carries tenant data — `/api/sprints/<id>`
 * names a real sprint — so a ranking built from request paths would publish identifiers onto an operator
 * page and into whatever it is copied into. And an unbounded label space means the cardinality of the
 * ranking is decided by traffic rather than by design, which is how a "top routes" panel ends up with
 * ten thousand distinct rows.
 */
export const ROUTE_FAMILIES = [
  'api.dashboard',
  'api.search',
  'api.builders',
  'api.alerts',
  'api.sprints',
  'api.recommendations',
  'api.organizations',
  'api.billing',
  'api.admin',
  'api.auth',
  'api.public',
  'page.dashboard',
  'page.public',
  'other',
] as const
export type RouteFamily = (typeof ROUTE_FAMILIES)[number]

/** A bounded ranking. Labels come from a closed set; see `ROUTE_FAMILIES`. */
export const rankedRouteRowsSchema = z
  .array(
    z.object({
      family: z.enum(ROUTE_FAMILIES),
      value: z.number().finite(),
      unit: z.enum(METRIC_UNITS),
    }),
  )
  .max(ADMIN_METRIC_LIMITS.rankedRows)

/**
 * A section envelope. Mirrors `sectionEnvelope` in the dashboard contracts, with one addition:
 * `partial`.
 *
 * An admin section can genuinely be half-answered — traffic counters present while the latency
 * histogram's backing store is missing — and collapsing that into `unavailable` throws away numbers an
 * operator has, while collapsing it into `ready` hides the ones they do not. `partial` carries the data
 * *and* the reason, which is the only honest option of the three.
 */
function sectionEnvelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), generatedAt, window: metricWindowSchema, data }),
    z.object({
      status: z.literal('partial'),
      generatedAt,
      window: metricWindowSchema,
      code: z.enum(ADMIN_SECTION_UNAVAILABLE_CODES),
      data,
    }),
    z.object({ status: z.literal('unavailable'), code: z.enum(ADMIN_SECTION_UNAVAILABLE_CODES) }),
  ])
}

const metricsBody = z.object({
  values: z.array(metricValueSchema).max(24),
  series: z.array(metricSeriesSchema).max(6).optional(),
  ranked: rankedRouteRowsSchema.optional(),
})

/** Every section shares one body shape. The difference between them is which keys they fill, not the type. */
export const adminMetricSectionSchema = sectionEnvelope(metricsBody)
export type AdminMetricSectionPayload = z.infer<typeof adminMetricSectionSchema>

/** One section's response, which is what a per-section route returns. */
export const adminMetricSectionResponseSchema = z.object({
  schemaVersion: z.literal(ADMIN_METRICS_SCHEMA_VERSION),
  section: z.enum(ADMIN_METRIC_SECTIONS),
  variant: z.string().min(1),
  payload: adminMetricSectionSchema,
})
export type AdminMetricSectionResponse = z.infer<typeof adminMetricSectionResponseSchema>

/**
 * Validates a `section`/`range`/`variant` triple from a URL.
 *
 * Refuses rather than defaults, and the variant is checked *against its section* — `traffic` accepts
 * `latency`, `search` does not, and a cross-section variant is the kind of URL that renders a plausible
 * wrong view. Returns a discriminated result instead of throwing so a route can answer 400 with the
 * reason rather than 500.
 */
export function parseSectionRequest(input: {
  section?: string | null
  range?: string | null
  variant?: string | null
}):
  | { ok: true; section: AdminMetricSection; range: AdminMetricRange; variant: string }
  | { ok: false; error: string } {
  const section = ADMIN_METRIC_SECTIONS.find((candidate) => candidate === input.section)
  if (!section) {
    return { ok: false, error: `unknown section; expected one of ${ADMIN_METRIC_SECTIONS.join(', ')}` }
  }
  const range = input.range
    ? ADMIN_METRIC_RANGES.find((candidate) => candidate === input.range)
    : ('24h' as const)
  if (!range) {
    return { ok: false, error: `unknown range; expected one of ${ADMIN_METRIC_RANGES.join(', ')}` }
  }
  const allowed = variantsFor(section)
  const variant = input.variant ?? allowed[0]
  if (!allowed.includes(variant)) {
    return { ok: false, error: `variant "${variant}" is not valid for section "${section}"` }
  }
  return { ok: true, section, range, variant }
}
