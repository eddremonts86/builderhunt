import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { listRecentAbuseSignals } from '~/shared/lib/repositories/abuse-signals'
import { getAccountRisk, setAccountRiskStageByAdmin, withPlatformUser } from '~/shared/lib/repositories/account-risk'
import type { EnforcementStage } from '~/shared/lib/abuse/enforcement'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

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
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const limitParam = Number(url.searchParams.get('limit'))
          const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT

          const signals = await listRecentAbuseSignals(limit)
          const uniqueUserIds = [...new Set(signals.map((signal) => signal.userId).filter((id): id is string => Boolean(id)))]
          const stageEntries = await Promise.all(uniqueUserIds.map(async (userId) => {
            const record = await withPlatformUser(userId, (transaction) => getAccountRisk(transaction, userId))
            return [userId, record] as const
          }))
          const stageByUserId = Object.fromEntries(
            stageEntries.map(([userId, record]) => [
              userId,
              record ? { stage: record.stage, riskScore: record.riskScore, reason: record.reason, updatedAt: record.updatedAt } : null,
            ]),
          )

          return Response.json({ signals, stageByUserId })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin abuse feed error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
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
