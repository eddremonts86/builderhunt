import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import {
  AutoRechargeError,
  configureAutoRecharge,
  disableAutoRecharge,
  getAutoRechargeRuleForOwner,
  type AutoRechargeErrorCode,
} from '~/shared/lib/billing/auto-recharge'
import { BillingAuthorizationError, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { getBillingProvider } from '~/shared/lib/billing/stripe-provider'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const AutoRechargeBody = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    packCatalogKey: z.string().min(1),
    balanceThresholdUnits: z.number().int().nonnegative(),
    monthlyCapCents: z.number().int().positive(),
    acknowledgedOffSessionCharge: z.literal(true),
  }).strict(),
])

const AUTO_RECHARGE_ERROR_STATUS: Record<AutoRechargeErrorCode, number> = {
  no_active_subscription: 403,
  unknown_pack_catalog_key: 400,
  invalid_threshold: 400,
  invalid_monthly_cap: 400,
  setup_requires_action: 409,
  provider_error: 502,
}

/** Owner-only and recent-auth-gated (`'billing:auto-recharge'` is in `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`) for both GET and PUT — spec.md classifies auto-recharge configuration itself as payment-method-adjacent, not merely its mutation. */
export const Route = createFileRoute('/api/billing/auto-recharge')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const authSession = await auth.api.getSession({ headers: request.headers })
          requireBillingPermission(
            principal,
            'billing:auto-recharge',
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
          )

          const rule = await withTenantContext(principal, (tx) => getAutoRechargeRuleForOwner(tx, principal))
          return Response.json({ rule })
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Auto-recharge read error:', error)
          return Response.json({ error: 'Failed to read auto-recharge configuration' }, { status: 500 })
        }
      },
      PUT: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const authSession = await auth.api.getSession({ headers: request.headers })
          requireBillingPermission(
            principal,
            'billing:auto-recharge',
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
          )

          const parsed = AutoRechargeBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const body = parsed.data
          if (body.enabled === false) {
            const rule = await withTenantContext(principal, (tx) => disableAutoRecharge(tx, principal))
            return Response.json({ rule })
          }

          const provider = getBillingProvider()
          const rule = await withTenantContext(principal, (tx) => configureAutoRecharge(tx, principal, body, { provider }))
          return Response.json({ rule })
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof AutoRechargeError) {
            return Response.json({ error: error.message, code: error.code }, { status: AUTO_RECHARGE_ERROR_STATUS[error.code] })
          }
          console.error('Auto-recharge configure error:', error)
          return Response.json({ error: 'Failed to update auto-recharge configuration' }, { status: 500 })
        }
      },
    },
  },
})
