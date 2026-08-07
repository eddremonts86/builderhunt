import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { pageAbuseSignals } from '~/shared/lib/repositories/abuse-signals'
import { abuseSignalsCapability } from '~/shared/lib/table/capabilities/abuse-signals'
import { platformTablePageHandler } from '~/shared/lib/table/handler'
import { getAccountRisk, setAccountRiskStageByAdmin, withPlatformUser } from '~/shared/lib/repositories/account-risk'
import type { EnforcementStage } from '~/shared/lib/abuse/enforcement'

const ManualActionBody = z.object({
  userId: z.string().min(1),
  action: z.enum(['clear', 'warn', 'stepup', 'block']),
  reason: z.string().max(500).optional(),
}).strict()

const STAGE_BY_ACTION: Record<z.infer<typeof ManualActionBody>['action'], EnforcementStage> = {
  clear: 'observe',
  warn: 'warned',
  stepup: 'stepup',
  block: 'blocked',
}

/**
 * Platform-admin abuse console feed + manual-action endpoint (abuse-and-usage-integrity Phase 5
 * task 3). Linked-account clusters have their own existing route (`/api/admin/abuse/clusters`,
 * Phase 3) — this route covers the other two pieces the console needs: a recent `abuse_signals`
 * feed and each signal's current enforcement stage, plus the manual clear/warn/force-step-up/block
 * actions, each audited via `auditPlatformAdminAction`.
 */
export const Route = createFileRoute('/api/admin/abuse/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      /**
       * One keyset page of the feed.
       *
       * It used to answer `?limit=100` and nothing else, which meant the console could reach the
       * newest hundred signals and no further — an operator investigating last week's incident had
       * no way to get there. Sorting, filtering and faceting now happen in Postgres through the
       * shared builder.
       *
       * Each row carries its own enforcement stage, annotated on the page the way sprint results
       * annotates `tracked`: the page's distinct user ids, one read each, exactly as many reads as
       * the flat `stageByUserId` map cost — but as a property of the row, so the shape stays a
       * `PageResult` instead of a `PageResult` with something taped to it.
       */
      GET: async ({ request }) => platformTablePageHandler({
        capability: abuseSignalsCapability,
        request,
        load: async ({ search }) => {
          const page = await pageAbuseSignals(search.query, search.page)
          const uniqueUserIds = [...new Set(page.rows.map((signal) => signal.userId).filter((id): id is string => Boolean(id)))]
          const stageEntries = await Promise.all(uniqueUserIds.map(async (userId) => {
            const record = await withPlatformUser(userId, (transaction) => getAccountRisk(transaction, userId))
            return [userId, record] as const
          }))
          const stageByUserId = new Map(stageEntries.map(([userId, record]) => [
            userId,
            record ? { stage: record.stage, riskScore: record.riskScore, reason: record.reason, updatedAt: record.updatedAt } : null,
          ]))

          return {
            ...page,
            rows: page.rows.map((signal) => ({
              ...signal,
              stage: (signal.userId ? stageByUserId.get(signal.userId) : null) ?? null,
            })),
          }
        },
      }),
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = ManualActionBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const { userId, action } = parsed.data
          const stage = STAGE_BY_ACTION[action]
          const reason = parsed.data.reason?.trim() || `Manually set to "${stage}" by admin ${principal.userId}`

          const updated = await setAccountRiskStageByAdmin(userId, stage, reason)

          await auditPlatformAdminAction(principal, {
            action: `admin.abuse.account.${action}`,
            targetType: 'account_risk',
            targetId: userId,
            result: 'allowed',
            details: { stage, reason },
          })

          return Response.json({ userId, stage: updated.stage, riskScore: updated.riskScore, reason: updated.reason, updatedAt: updated.updatedAt })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin abuse action error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
