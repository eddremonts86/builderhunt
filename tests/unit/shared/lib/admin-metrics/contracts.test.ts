import { describe, expect, it } from 'vitest'
import {
  ADMIN_METRIC_LIMITS,
  ADMIN_METRIC_RANGES,
  ADMIN_METRIC_SECTIONS,
  ADMIN_METRICS_SCHEMA_VERSION,
  adminMetricSectionResponseSchema,
  adminMetricSectionSchema,
  metricSeriesSchema,
  metricThresholdSchema,
  metricValueSchema,
  metricWindowSchema,
  parseSectionRequest,
  rankedRouteRowsSchema,
  variantsFor,
} from '../../../../../src/shared/lib/admin-metrics/contracts'

/**
 * Plan 57, Admin track — "Define versioned Admin Metrics section contracts".
 *
 * The task's Verify line names six things the schema must reject, and each has its own case below. They
 * are all one idea: on an operator page a *plausible* number is worse than a missing one, because the
 * page exists to be believed at 02:00 and acted on.
 */

const WINDOW = {
  range: '24h' as const,
  from: '2026-08-10T00:00:00.000Z',
  to: '2026-08-11T00:00:00.000Z',
  timezone: 'Europe/Copenhagen',
}

const PROCESS_IDENTITY = { pid: 42, startedAt: '2026-08-11T09:00:00.000Z', instance: 'web-1' }

function value(over: Record<string, unknown> = {}) {
  return { key: 'requests_total', value: 1500, unit: 'count', scope: 'database', ...over }
}

describe('metric windows', () => {
  it('requires a timezone, because a daily bucket boundary is a local-time question', () => {
    // Two operators in different places reading "yesterday" off the same payload have to be reading the
    // same day, and without a timezone the payload does not say which one that is.
    const { timezone: _dropped, ...withoutTimezone } = WINDOW
    expect(metricWindowSchema.safeParse(withoutTimezone).success).toBe(false)
    expect(metricWindowSchema.safeParse(WINDOW).success).toBe(true)
  })

  it('refuses a window that ends before it starts', () => {
    expect(metricWindowSchema.safeParse({ ...WINDOW, from: WINDOW.to, to: WINDOW.from }).success).toBe(false)
  })

  it('refuses a range it has no index for', () => {
    expect(metricWindowSchema.safeParse({ ...WINDOW, range: '18mo' }).success).toBe(false)
    for (const range of ADMIN_METRIC_RANGES) {
      expect(metricWindowSchema.safeParse({ ...WINDOW, range }).success).toBe(true)
    }
  })
})

describe('units and scope are mandatory', () => {
  it('refuses a number with no unit', () => {
    // 1500 is fifteen hundred requests, or one and a half seconds, or 1.5 KB.
    const { unit: _dropped, ...withoutUnit } = value()
    expect(metricValueSchema.safeParse(withoutUnit).success).toBe(false)
  })

  it('refuses a number with no scope', () => {
    const { scope: _dropped, ...withoutScope } = value()
    expect(metricValueSchema.safeParse(withoutScope).success).toBe(false)
  })

  it('refuses an invented unit or scope', () => {
    expect(metricValueSchema.safeParse(value({ unit: 'furlongs' })).success).toBe(false)
    expect(metricValueSchema.safeParse(value({ scope: 'vibes' })).success).toBe(false)
  })

  it('refuses a display string where a key belongs', () => {
    // The client owns the label. A server-supplied display string is one i18n change from being wrong in
    // a place nobody looks, and it invites sentence-shaped keys that no chart can group by.
    expect(metricValueSchema.safeParse(value({ key: 'Requests Total' })).success).toBe(false)
    expect(metricValueSchema.safeParse(value({ key: 'requests_total' })).success).toBe(true)
  })
})

describe('a process counter cannot present as a platform total', () => {
  it('refuses `platformTotal` on a process-scoped counter', () => {
    /**
     * The sentence this rejects is "this instance's counter is the platform's number".
     *
     * `metrics.get()` starts at zero when the process starts, is per-instance, and is reset by a deploy.
     * For a multi-instance deployment it is a fraction of the truth and after a deploy it is almost
     * none of it — and an operator who reads it as a total acts on a number that is wrong in the
     * reassuring direction.
     */
    const parsed = metricValueSchema.safeParse(
      value({ scope: 'process', platformTotal: true, processIdentity: PROCESS_IDENTITY }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('platformTotal'))).toBe(true)
    }
  })

  it('requires the process identity, so two instances are never summed', () => {
    const parsed = metricValueSchema.safeParse(value({ scope: 'process' }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('processIdentity'))).toBe(true)
    }
    expect(metricValueSchema.safeParse(value({ scope: 'process', processIdentity: PROCESS_IDENTITY })).success).toBe(true)
  })

  it('refuses a process identity on a database aggregate', () => {
    // The reverse mistake, and it matters: a persisted total labelled with a pid reads as per-instance
    // and would be summed by somebody trying to reconstruct the platform figure.
    expect(metricValueSchema.safeParse(value({ scope: 'database', processIdentity: PROCESS_IDENTITY })).success).toBe(false)
  })

  it('allows a database aggregate to claim the platform', () => {
    expect(metricValueSchema.safeParse(value({ scope: 'database', platformTotal: true })).success).toBe(true)
  })
})

describe('thresholds are checked for direction', () => {
  it('accepts a latency pair rising to critical', () => {
    expect(metricThresholdSchema.safeParse({ direction: 'higher_is_worse', warn: 200, critical: 2000 }).success).toBe(true)
  })

  it('refuses a swapped pair, which would never fire', () => {
    /**
     * Without `direction` a schema can only assert two numbers exist. Critical at 200 ms and warn at
     * 2 s parses, renders, and then never raises the alert an operator is relying on — the failure is
     * silence, which is the hardest kind to notice.
     */
    expect(metricThresholdSchema.safeParse({ direction: 'higher_is_worse', warn: 2000, critical: 200 }).success).toBe(false)
    expect(metricThresholdSchema.safeParse({ direction: 'lower_is_worse', warn: 0.9, critical: 0.99 }).success).toBe(false)
  })

  it('accepts an availability pair falling to critical', () => {
    expect(metricThresholdSchema.safeParse({ direction: 'lower_is_worse', warn: 0.99, critical: 0.9 }).success).toBe(true)
  })
})

describe('bounds are enforced at parse time, not trimmed', () => {
  it('refuses more than 90 buckets', () => {
    // A truncating parser turns "this series forgot its window" into a chart that looks fine.
    const bucket = (i: number) => ({ at: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), value: i })
    const ok = { key: 'requests', unit: 'count', scope: 'database', buckets: Array.from({ length: ADMIN_METRIC_LIMITS.seriesBuckets }, (_, i) => bucket(i)) }
    expect(metricSeriesSchema.safeParse(ok).success).toBe(true)
    expect(metricSeriesSchema.safeParse({ ...ok, buckets: [...ok.buckets, bucket(999)] }).success).toBe(false)
  })

  it('refuses more than 10 ranked rows', () => {
    const row = { family: 'api.search' as const, value: 1, unit: 'count' as const }
    expect(rankedRouteRowsSchema.safeParse(Array.from({ length: ADMIN_METRIC_LIMITS.rankedRows }, () => row)).success).toBe(true)
    expect(rankedRouteRowsSchema.safeParse(Array.from({ length: ADMIN_METRIC_LIMITS.rankedRows + 1 }, () => row)).success).toBe(false)
  })
})

describe('route labels come from a closed set', () => {
  it('refuses an arbitrary path, which would publish tenant identifiers', () => {
    /**
     * `/api/sprints/abc123` names a real sprint. A ranking built from raw request paths puts tenant
     * identifiers onto an operator page and into whatever it is pasted into — and lets traffic, rather
     * than design, decide how many distinct rows the ranking has.
     */
    expect(rankedRouteRowsSchema.safeParse([{ family: '/api/sprints/abc123', value: 1, unit: 'count' }]).success).toBe(false)
    expect(rankedRouteRowsSchema.safeParse([{ family: 'api.sprints', value: 1, unit: 'count' }]).success).toBe(true)
  })
})

describe('section envelopes', () => {
  const body = { values: [value()] }

  it('carries a window and a generatedAt when it carries data', () => {
    expect(adminMetricSectionSchema.safeParse({ status: 'ready', generatedAt: WINDOW.to, window: WINDOW, data: body }).success).toBe(true)
    // An aggregate rendered without a time is a claim about *now*, and a cached one makes that false.
    expect(adminMetricSectionSchema.safeParse({ status: 'ready', window: WINDOW, data: body }).success).toBe(false)
  })

  it('cannot express a failure as data', () => {
    // `unavailable` carries no rows at all, so "this section failed" can never arrive looking like
    // "there is nothing here yet" — the confusion the page it replaces was built on.
    const parsed = adminMetricSectionSchema.safeParse({ status: 'unavailable', code: 'timeout', data: body })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect('data' in parsed.data).toBe(false)
  })

  it('has a partial state, because half-answered is a real thing for an admin section', () => {
    /**
     * Traffic counters present while the latency histogram's store is missing. Collapsing that into
     * `unavailable` throws away numbers the operator has; collapsing it into `ready` hides the ones they
     * do not. `partial` carries the data and the reason.
     */
    const parsed = adminMetricSectionSchema.safeParse({
      status: 'partial',
      generatedAt: WINDOW.to,
      window: WINDOW,
      code: 'insufficient_history',
      data: body,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses an unavailable code it does not know', () => {
    expect(adminMetricSectionSchema.safeParse({ status: 'unavailable', code: 'because' }).success).toBe(false)
  })

  it('pins the schema version exactly', () => {
    const response = {
      schemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
      section: 'traffic' as const,
      variant: 'rate',
      payload: { status: 'ready' as const, generatedAt: WINDOW.to, window: WINDOW, data: body },
    }
    expect(adminMetricSectionResponseSchema.safeParse(response).success).toBe(true)
    // Not "greater than or equal": a newer server is exactly the case where a removed field arrives
    // silently absent, which is the mismatch worth refusing.
    expect(adminMetricSectionResponseSchema.safeParse({ ...response, schemaVersion: ADMIN_METRICS_SCHEMA_VERSION + 1 }).success).toBe(false)
  })
})

describe('parseSectionRequest', () => {
  it('refuses an unknown section rather than defaulting', () => {
    const parsed = parseSectionRequest({ section: 'surveillance' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('unknown section')
  })

  it('defaults the range to 24h and refuses an unknown one', () => {
    expect(parseSectionRequest({ section: 'traffic' })).toMatchObject({ ok: true, range: '24h' })
    expect(parseSectionRequest({ section: 'traffic', range: '18mo' }).ok).toBe(false)
  })

  it('checks the variant against its own section, not against every variant', () => {
    /**
     * `latency` is a traffic variant and not a search one. A cross-section variant that "worked" would
     * render a plausible wrong view, and an operator sharing that URL would send somebody somewhere
     * else than where they were looking.
     */
    expect(parseSectionRequest({ section: 'traffic', variant: 'latency' }).ok).toBe(true)
    const wrong = parseSectionRequest({ section: 'search', variant: 'latency' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain('not valid for section "search"')
  })

  it('defaults the variant to its section\'s first, for every section', () => {
    for (const section of ADMIN_METRIC_SECTIONS) {
      const parsed = parseSectionRequest({ section })
      expect(parsed.ok, section).toBe(true)
      if (parsed.ok) expect(parsed.variant).toBe(variantsFor(section)[0])
    }
  })

  it('has at least one variant for every section, so no section is unreachable', () => {
    for (const section of ADMIN_METRIC_SECTIONS) expect(variantsFor(section).length).toBeGreaterThan(0)
  })
})
