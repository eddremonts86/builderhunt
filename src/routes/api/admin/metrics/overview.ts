/**
 * The Admin Metrics section the page loads first and re-reads on a timer (plan 57, Admin track —
 * "Split the monolithic Admin Metrics API and remove frequent billing scans").
 *
 * ## Why this is its own file when `sections.ts` could serve it
 *
 * Not symmetry — cost. This is the frequent path: it runs on first paint and again every sixty seconds
 * while the tab is in front. Everything expensive that used to be on that path is the reason this task
 * exists, and a reviewer asking "what does the sixty-second refresh actually run?" should be able to
 * answer it by reading one short file rather than by following a switch through eight cases.
 *
 * So the answer is written here and is checkable: **two indexed aggregate reads, concurrently, and
 * nothing else.** No billing sweep — `getBillingOperationsMetrics` walked organizations and is why the
 * old endpoint was expensive on a timer; detailed billing lives on `/api/admin/billing/metrics`, which is
 * fetched by the console that actually renders it. No conversion query. No in-process counters either:
 * those are the `runtime` section, and mixing them in beside database aggregates is how a per-instance
 * number gets read as a platform total.
 *
 * `tests/unit/routes/admin-metrics-overview.test.ts` asserts the absence rather than a latency budget,
 * because a budget passes on a fast machine while the sweep is still there.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { ADMIN_METRICS_SCHEMA_VERSION, parseSectionRequest } from '~/shared/lib/admin-metrics/contracts'
import { buildSection } from '~/shared/lib/admin-metrics/sections'

export const Route = createFileRoute('/api/admin/metrics/overview')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          const url = new URL(request.url)
          // The section is fixed; only the range is a caller choice, and it is still validated rather
          // than trusted — `?range=18mo` would otherwise reach an aggregate with no index for it.
          const parsed = parseSectionRequest({
            section: 'overview',
            range: url.searchParams.get('range'),
            variant: url.searchParams.get('variant'),
          })
          if (!parsed.ok) {
            return Response.json({ error: 'invalid_request', detail: parsed.error }, { status: 400 })
          }

          let payload
          try {
            payload = await buildSection({ section: 'overview', range: parsed.range, variant: parsed.variant })
          } catch (sectionError) {
            // Same confinement as `sections.ts`: an honest "this is broken" beats a 500 on the path the
            // page polls, because a 500 there empties a dashboard that was working a minute ago.
            console.error('admin metrics overview failed:', sectionError)
            payload = { status: 'unavailable' as const, code: 'error' as const }
          }

          return Response.json({
            schemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
            section: 'overview' as const,
            variant: parsed.variant,
            payload,
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin metrics overview error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
