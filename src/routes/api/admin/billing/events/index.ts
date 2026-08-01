import { createFileRoute } from '@tanstack/react-router'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import {
  BILLING_WEBHOOK_EVENT_STATUSES,
  listBillingWebhookEvents,
  type BillingWebhookEventCursor,
} from '~/shared/lib/repositories/billing-events'

/**
 * Bounded, filtered discovery over `billing_webhook_events` (plans/UI/tasks.md Wave 5 "Add billing
 * webhook and dead-letter discovery") — read-only, platform-admin only. Never returns
 * `payloadEncrypted` or a raw error message; see `billing-events.ts` for what's redacted and why.
 */
export const Route = createFileRoute('/api/admin/billing/events/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)

          const statusParam = url.searchParams.get('status')
          if (statusParam && !(BILLING_WEBHOOK_EVENT_STATUSES as readonly string[]).includes(statusParam)) {
            return Response.json({ error: `status must be one of: ${BILLING_WEBHOOK_EVENT_STATUSES.join(', ')}` }, { status: 400 })
          }
          const eventType = url.searchParams.get('eventType') ?? undefined
          const receivedFromParam = url.searchParams.get('receivedFrom')
          const receivedToParam = url.searchParams.get('receivedTo')
          const receivedFrom = receivedFromParam ? new Date(receivedFromParam) : undefined
          const receivedTo = receivedToParam ? new Date(receivedToParam) : undefined
          if ((receivedFrom && Number.isNaN(receivedFrom.getTime())) || (receivedTo && Number.isNaN(receivedTo.getTime()))) {
            return Response.json({ error: 'receivedFrom/receivedTo must be valid ISO-8601 timestamps' }, { status: 400 })
          }

          const cursorParam = url.searchParams.get('cursor')
          let cursor: BillingWebhookEventCursor | undefined
          if (cursorParam) {
            const [receivedAtRaw, id] = cursorParam.split('|')
            const receivedAt = new Date(receivedAtRaw ?? '')
            if (Number.isNaN(receivedAt.getTime()) || !id) {
              return Response.json({ error: 'Invalid cursor' }, { status: 400 })
            }
            cursor = { receivedAt, id }
          }

          const limitParam = url.searchParams.get('limit')
          const limit = limitParam ? Number(limitParam) : undefined
          if (limitParam && (!Number.isFinite(limit) || (limit as number) <= 0)) {
            return Response.json({ error: 'limit must be a positive number' }, { status: 400 })
          }

          const result = await listBillingWebhookEvents(
            { status: statusParam as (typeof BILLING_WEBHOOK_EVENT_STATUSES)[number] | undefined, eventType, receivedFrom, receivedTo },
            { cursor, limit },
          )

          await auditPlatformAdminAction(principal, {
            action: 'admin.billing.events.list',
            targetType: 'billing_webhook_event',
            targetId: null,
            result: 'allowed',
          })

          return Response.json({
            rows: result.rows,
            nextCursor: result.nextCursor ? `${result.nextCursor.receivedAt.toISOString()}|${result.nextCursor.id}` : null,
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin billing events list error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
