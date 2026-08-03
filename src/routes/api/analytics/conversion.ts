/**
 * Ingestion endpoint for the landing-funnel conversion-event stream (plan:
 * audit-conversion). Unauthenticated by design — fires from anonymous
 * landing/explore/signup pages. Validates the closed event schema, the
 * 5-minute clock-skew window, and rate-limits by request origin; never
 * persists that origin. Silently no-ops (200, no write) when the feature
 * flag is off, so toggling collection never breaks the pages that call it.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { env } from '~/shared/lib/env'
import { isWithinClockSkewWindow, parseConversionEvent } from '~/shared/lib/conversion-events'
import { recordConversionEvent } from '~/shared/lib/repositories/conversion-events'
import { getRateLimitId, rateLimit } from '~/shared/lib/rate-limit'

export const Route = createFileRoute('/api/analytics/conversion')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        // Kill switch: collection off entirely. Still 200s — the caller
        // (conversion-client.ts) should never treat "disabled" as an error.
        if (env.CONVERSION_EVENTS_ENABLED !== 'true') {
          return Response.json({ ok: true, recorded: false })
        }

        const limit = await rateLimit('conversion-events', getRateLimitId(request), 60, 60)
        if (!limit.allowed) {
          return Response.json(
            { error: 'rate_limited' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
          )
        }

        const body = await request.json().catch(() => null)
        const parsed = parseConversionEvent(body)
        if (!parsed.ok || !parsed.event) {
          return Response.json({ error: parsed.error ?? 'invalid_event' }, { status: 400 })
        }
        if (!isWithinClockSkewWindow(parsed.event.occurredAt)) {
          return Response.json({ error: 'timestamp_out_of_window' }, { status: 400 })
        }

        try {
          await recordConversionEvent(parsed.event)
        } catch (error) {
          // Telemetry must never surface a 500 to the caller's product flow —
          // log server-side for diagnosis, respond as if nothing happened.
          console.error('conversion event write failed:', error)
          return Response.json({ ok: true, recorded: false })
        }

        return Response.json({ ok: true, recorded: true })
      },
    },
  },
})
