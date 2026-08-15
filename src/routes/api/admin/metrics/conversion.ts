/**
 * Admin-only aggregate reporting for the landing-funnel conversion-event
 * stream (plan: audit-conversion). Returns raw counts, rates, and 95%
 * Wilson-score confidence intervals per named funnel metric, for a given
 * UTC day range and variant — never raw session ids or per-event rows.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { computeConversionRate, CONVERSION_VARIANTS } from '~/shared/lib/conversion-events'
import {
  countConversionSessionsByEvent,
  countOnboardingFunnelSessions,
  utcDay,
} from '~/shared/lib/repositories/conversion-events'
import { parseRolloutPercent } from '~/shared/lib/onboarding-rollout'
import { env } from '~/shared/lib/env'

/**
 * The widest window this endpoint will read (plan 57, Admin track).
 *
 * Ninety days, and the cap is not arbitrary: raw events are deleted after thirty
 * (`deleteExpiredConversionEvents`), so anything past that is a scan over a range that provably holds nothing.
 * A caller asking for eighteen months would get a sequential scan and a table of zeros that reads as a
 * collapse in conversion rather than as retention having done its job.
 */
const MAX_RANGE_DAYS = 90

const DAY = /^\d{4}-\d{2}-\d{2}$/

const querySchema = z
  .object({
    start: z.string().regex(DAY).optional(),
    end: z.string().regex(DAY).optional(),
    variant: z.enum(CONVERSION_VARIANTS).default('baseline'),
  })
  /**
   * `start <= end`, refused rather than swapped.
   *
   * Swapping would answer a question the caller did not ask, and the two orders mean different things to
   * whoever built the URL — a reversed range is far more likely a bug in their tooling than a typo they want
   * silently corrected. Both bounds are UTC calendar days, so the string comparison is the date comparison.
   */
  .refine((query) => !query.start || !query.end || query.start <= query.end, {
    message: 'start must not be after end',
    path: ['start'],
  })
  .refine(
    (query) => {
      if (!query.start || !query.end) return true
      const spanDays = (Date.parse(`${query.end}T00:00:00Z`) - Date.parse(`${query.start}T00:00:00Z`)) / 86_400_000
      return spanDays <= MAX_RANGE_DAYS
    },
    { message: `range must not exceed ${MAX_RANGE_DAYS} days`, path: ['end'] },
  )

// Primary/secondary funnel metrics, per spec §"Metrics" — each is a ratio of
// two named events' distinct-session counts within the requested range.
const METRIC_DEFINITIONS = [
  { key: 'landing_to_signup', numeratorEvent: 'signup_complete', denominatorEvent: 'landing_view' },
  { key: 'hero_signup_ctr', numeratorEvent: 'hero_signup_click', denominatorEvent: 'landing_view' },
  { key: 'hero_explore_ctr', numeratorEvent: 'hero_explore_click', denominatorEvent: 'landing_view' },
  { key: 'explore_search_completion', numeratorEvent: 'explore_search_complete', denominatorEvent: 'hero_explore_click' },
  { key: 'explore_to_signup_ctr', numeratorEvent: 'explore_signup_click', denominatorEvent: 'explore_search_complete' },
  { key: 'signup_completion', numeratorEvent: 'signup_complete', denominatorEvent: 'signup_submit' },
] as const

export const Route = createFileRoute('/api/admin/metrics/conversion')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          const url = new URL(request.url)
          const parsed = querySchema.safeParse({
            start: url.searchParams.get('start') ?? undefined,
            end: url.searchParams.get('end') ?? undefined,
            variant: url.searchParams.get('variant') ?? undefined,
          })
          if (!parsed.success) {
            return Response.json({ error: 'Invalid query', issues: parsed.error.flatten() }, { status: 400 })
          }

          const now = new Date()
          const defaultStart = utcDay(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000))
          const start = parsed.data.start ?? defaultStart
          const end = parsed.data.end ?? utcDay(now)
          const variant = parsed.data.variant

          /**
           * One query for every metric, not two per metric.
           *
           * This loop used to `await` a pair of counts per definition — twelve sequential round trips for six
           * metrics, growing by two with every metric added. The event names are collected first (deduplicated,
           * because `landing_view` is the denominator of three of them and `signup_complete` is a numerator
           * twice), counted in a single grouped query, and the rates computed from the map.
           *
           * So the query count is 1 whatever `METRIC_DEFINITIONS` grows to, which is what makes adding a funnel
           * step free rather than a cost an admin page pays on every load.
           */
          const eventNames = [
            ...new Set(METRIC_DEFINITIONS.flatMap((def) => [def.numeratorEvent, def.denominatorEvent])),
          ]
          const counts = await countConversionSessionsByEvent(eventNames, variant, start, end)

          const metrics: Record<string, ReturnType<typeof computeConversionRate> & { numeratorEvent: string; denominatorEvent: string }> = {}
          for (const def of METRIC_DEFINITIONS) {
            metrics[def.key] = {
              ...computeConversionRate(
                counts.get(def.numeratorEvent)?.sessions ?? 0,
                counts.get(def.denominatorEvent)?.sessions ?? 0,
              ),
              numeratorEvent: def.numeratorEvent,
              denominatorEvent: def.denominatorEvent,
            }
          }

          /**
           * The onboarding funnel, split by flow version and route (plan:
           * phase-2/03-onboarding-segmentado).
           *
           * A second query rather than a second endpoint, because it answers the same question in
           * the same window and an admin comparing the two should not have to line up two requests.
           *
           * Completion is `confirmation` viewed over `welcome` viewed, per `(flowVersion, preset)`.
           * Split by version because that is what the cohort rollout is for: "completion fell" is
           * not actionable, "completion fell on v2 while v1 held" is the sentence that stops a
           * ramp — and it cannot be written from a stream that does not distinguish the two.
           */
          const onboardingRows = await countOnboardingFunnelSessions(variant, start, end)
          const cells = new Map<string, { viewedFirst: number; viewedLast: number }>()
          for (const row of onboardingRows) {
            if (row.name !== 'onboarding_step_viewed') continue
            const key = `${row.flowVersion ?? 'unknown'}:${row.preset ?? 'unknown'}`
            const cell = cells.get(key) ?? { viewedFirst: 0, viewedLast: 0 }
            if (row.stepKey === 'welcome') cell.viewedFirst += row.sessions
            if (row.stepKey === 'confirmation') cell.viewedLast += row.sessions
            cells.set(key, cell)
          }
          const onboardingCompletion: Record<string, ReturnType<typeof computeConversionRate>> = {}
          for (const [key, cell] of cells) {
            onboardingCompletion[key] = computeConversionRate(cell.viewedLast, cell.viewedFirst)
          }

          return Response.json({
            start,
            end,
            variant,
            metrics,
            onboarding: {
              /** What the ramp is set to right now, so a reading is interpretable without a shell. */
              rolloutPercent: parseRolloutPercent(env.ONBOARDING_V2_ROLLOUT_PERCENT),
              /** Keyed `<flowVersion>:<preset>` — completion of the flow, not of any single step. */
              completion: onboardingCompletion,
              /** Every (event, version, route, step) cell, so a drop can be located rather than guessed at. */
              steps: onboardingRows,
            },
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('conversion metrics fetch failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
