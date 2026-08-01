/**
 * Alert test delivery (plans/UI/tasks.md Wave 4 "Expose alert test delivery"). Confirms an alert's
 * delivery mechanism actually works, using synthetic sample data — no real match is required and
 * none is recorded. `email`-channel alerts get a real test email through the same
 * `sendAlertDigestEmail` sender the worker uses; `dashboard`-channel alerts have nothing to send (an
 * in-app "delivery" is just the alert showing up in the Matches feed when it really triggers), so
 * the response confirms the channel is reachable without fabricating a trigger row.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findOrganizationAlert } from '~/shared/lib/repositories/organization-alerts'
import { findWorkerUserEmail } from '~/shared/lib/repositories/alerts-worker'
import { sendAlertDigestEmail } from '~/shared/lib/email'
import { getAuthedRateLimitId, rateLimit } from '~/shared/lib/rate-limit'

const TEST_LIMIT = 10
const TEST_WINDOW_SECONDS = 60 * 60

export const Route = createFileRoute('/api/alerts/$id/test-send')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const limited = await rateLimit(
            'alert-test-send',
            getAuthedRateLimitId({ userId: principal.userId, organizationId: principal.organizationId }),
            TEST_LIMIT,
            TEST_WINDOW_SECONDS,
          )
          if (!limited.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } },
            )
          }

          // Same tenant-scoped WHERE every other /api/alerts/* route uses — a deleted alert and a
          // foreign one both read back `null` here, so both 404 identically (no enumeration oracle).
          const alert = await withTenantContext(principal, (tx) =>
            findOrganizationAlert(tx, principal.organizationId, params.id))
          if (!alert) return Response.json({ error: 'Alert not found' }, { status: 404 })
          if (!alert.enabled) {
            return Response.json({ error: 'alert_disabled', message: 'Resume this radar before testing it.' }, { status: 409 })
          }

          if (alert.deliveryChannel !== 'email') {
            return Response.json({ delivered: true, channel: 'dashboard' })
          }

          const email = await findWorkerUserEmail(principal.userId)
          if (!email) {
            return Response.json({ delivered: false, channel: 'email', degraded: true, error: 'no_email_on_file' }, { status: 200 })
          }

          const result = await sendAlertDigestEmail(email, [{
            alertName: alert.name,
            username: 'test-builder',
            displayName: 'Test Builder',
            source: 'github',
            profileUrl: 'https://github.com/octocat',
            eventType: 'test_delivery',
          }], 'This is a test delivery — no real match triggered it.')

          if (!result.ok) {
            return Response.json({ delivered: false, channel: 'email', degraded: true, error: result.error ?? 'send_failed' })
          }
          return Response.json({ delivered: true, channel: 'email' })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('alert test-send error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
