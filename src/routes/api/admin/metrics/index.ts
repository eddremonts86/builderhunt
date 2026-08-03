import { createFileRoute } from '@tanstack/react-router'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { evaluateBillingAlerts, getBillingOperationsMetrics } from '~/shared/lib/billing/operations-metrics'
import { metrics } from '~/shared/lib/metrics'
import { getOnboardingActivationMetrics, getPlatformAccountMetrics } from '~/shared/lib/repositories/platform-billing'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'
import { env } from '~/shared/lib/env'
import { getRemovalRequestMetrics } from '~/shared/lib/repositories/profile-removal'

export const Route = createFileRoute('/api/admin/metrics/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          // In-process metrics
          const inProcess = metrics.get()

          // DB aggregates
          const now = new Date()
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

          const accountMetrics = await getPlatformAccountMetrics(oneDayAgo, oneWeekAgo)
          const onboardingMetrics = await getOnboardingActivationMetrics(oneWeekAgo)
          const discovery = await getDiscoveryState().catch(() => null)
          const billingMetrics = await getBillingOperationsMetrics()

          /**
           * Absent, not zero, while the feature is off.
           *
           * `PROFILE_REMOVAL_ENABLED === 'false'` means no one can file a removal request, so a `removals`
           * block reading all-zeros would be a lie of implication: a dashboard would render "0 pending" and an
           * operator would conclude the queue is empty rather than that the door is shut. Omitting the key is
           * the only answer that cannot be misread.
           */
          const removals = env.PROFILE_REMOVAL_ENABLED === 'true'
            ? await getRemovalRequestMetrics().catch(() => null)
            : null

          const activationRate7d = accountMetrics.newUsersLast7d > 0
            ? onboardingMetrics.onboardingCompletedLast7d / accountMetrics.newUsersLast7d
            : null

          return Response.json({
            inProcess,
            db: {
              ...accountMetrics,
              onboardingCompleted: onboardingMetrics.onboardingCompleted,
              onboardingSkipped: onboardingMetrics.onboardingSkipped,
              activationRate7d,
              totalSavedQueries: null,
              totalBuilders: null,
              totalNotes: null,
            },
            // plans/phase-1/52-audit-trust §"Add trust runtime gates and redacted metrics" — counts and
            // states only. See `getRemovalRequestMetrics` for what is deliberately absent and why.
            ...(removals ? { removals } : {}),
            discovery: discovery && {
              cursor: discovery.cursor,
              lastCellKey: discovery.lastCellKey,
              lastRunAt: discovery.lastRunAt,
              stats: discovery.stats,
            },
            // plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Add financial notifications, metrics, and
            // alerts" — checkout/recovery/webhook-age/ledger-invariant/auto-recharge/cost-margin/
            // country-gate metrics, plus the critical SLO alerts computed from them.
            billing: { ...billingMetrics, alerts: evaluateBillingAlerts(billingMetrics) },
            server: {
              nodeVersion: process.version,
              platform: process.platform,
              pid: process.pid,
              memoryUsage: process.memoryUsage(),
            },
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin metrics error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
