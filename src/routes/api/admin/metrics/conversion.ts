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
import { countConversionSessions, utcDay } from '~/shared/lib/repositories/conversion-events'

const querySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  variant: z.enum(CONVERSION_VARIANTS).default('baseline'),
})

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

          const metrics: Record<string, ReturnType<typeof computeConversionRate> & { numeratorEvent: string; denominatorEvent: string }> = {}
          for (const def of METRIC_DEFINITIONS) {
            const [numerator, denominator] = await Promise.all([
              countConversionSessions(def.numeratorEvent, variant, start, end),
              countConversionSessions(def.denominatorEvent, variant, start, end),
            ])
            metrics[def.key] = {
              ...computeConversionRate(numerator.sessions, denominator.sessions),
              numeratorEvent: def.numeratorEvent,
              denominatorEvent: def.denominatorEvent,
            }
          }

          return Response.json({ start, end, variant, metrics })
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
