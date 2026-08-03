import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import {
  createSellerProfileVersion,
  getCurrentSellerProfile,
  listSellerProfileHistory,
  SellerProfileInputSchema,
} from '~/shared/lib/billing/seller-profile'

export const Route = createFileRoute('/api/admin/billing/configuration')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const [current, history] = await Promise.all([getCurrentSellerProfile(), listSellerProfileHistory()])
          return Response.json({ current, history })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing configuration read error:', err)
          return Response.json({ current: null, history: [] })
        }
      },
      PUT: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = SellerProfileInputSchema.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const created = await createSellerProfileVersion(parsed.data, principal.userId)
          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.seller-configuration.create-version',
            targetType: 'billing_seller_profile',
            targetId: created.id,
            result: 'allowed',
            details: { version: created.version },
          })
          return Response.json(created)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing configuration write error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
