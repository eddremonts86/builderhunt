import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { issueRiskException, listRiskExceptions, revokeRiskException, RiskExceptionError } from '~/shared/lib/billing/risk'

const IssueExceptionBody = z.object({
  organizationId: z.string().min(1),
  reason: z.string().min(1).max(500),
  durationMs: z.number().int().positive(),
}).strict()

const RevokeExceptionBody = z.object({
  organizationId: z.string().min(1),
  exceptionId: z.string().min(1),
}).strict()

/**
 * Platform-operator review queue for §8 task 3's fraud/high-volume exception controls — never an
 * organization role, matching every other `api/admin/billing/*` route's separation.
 */
export const Route = createFileRoute('/api/admin/billing/risk-exceptions')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const organizationId = new URL(request.url).searchParams.get('organizationId')
          if (!organizationId) return Response.json({ error: 'organizationId query parameter is required' }, { status: 400 })

          const exceptions = await listRiskExceptions(organizationId)
          return Response.json({ exceptions })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin risk-exceptions read error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)
          const parsed = IssueExceptionBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const exception = await issueRiskException(principal, parsed.data)
          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.risk-exception.issue',
            targetType: 'billing_risk_exception',
            targetId: exception.id,
            organizationId: exception.organizationId,
            result: 'allowed',
            details: { durationMs: parsed.data.durationMs },
          })
          return Response.json({ exception })
        } catch (err) {
          if (err instanceof RiskExceptionError) {
            return Response.json({ error: err.message, code: err.code }, { status: 400 })
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin risk-exceptions issue error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)
          const parsed = RevokeExceptionBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const exception = await revokeRiskException(parsed.data.organizationId, parsed.data.exceptionId)
          if (!exception) return Response.json({ error: 'Exception not found or already revoked' }, { status: 404 })

          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.risk-exception.revoke',
            targetType: 'billing_risk_exception',
            targetId: exception.id,
            organizationId: exception.organizationId,
            result: 'allowed',
          })
          return Response.json({ exception })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin risk-exceptions revoke error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
