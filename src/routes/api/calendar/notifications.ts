import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { listNotificationsRequestSchema, markNotificationsReadRequestSchema } from '~/shared/lib/interview-api'
import { countOwnUnreadNotifications, listOwnNotifications, markOwnNotificationsRead } from '~/lib/calendar/service'
import { calendarErrorResponse } from './events/index'

/**
 * The caller's own calendar notification feed (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Add calendar event APIs").
 *
 * Every read and write is scoped to `principal.userId` inside the service, with no admin override
 * anywhere in the path. Mark-read takes an explicit id list rather than a "mark everything"
 * switch, and an id the caller does not own simply comes back unmarked — the response never
 * distinguishes "not yours" from "does not exist".
 */

/**
 * Opaque `<epoch-millis>.<uuid>` keyset cursor.
 *
 * Opaque to the client but not encrypted, and deliberately not: it encodes only a timestamp and a
 * row id the caller already received in the previous page. A forged cursor can move the caller's
 * own window around and nothing else, because the query still filters on their user id.
 */
function encodeCursor(cursor: { createdAt: Date; id: string }): string {
  return `${cursor.createdAt.getTime()}.${cursor.id}`
}

function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null
  const separator = raw.indexOf('.')
  if (separator <= 0) return null
  const millis = Number(raw.slice(0, separator))
  const id = raw.slice(separator + 1)
  if (!Number.isFinite(millis) || !/^[0-9a-f-]{36}$/i.test(id)) return null
  return { createdAt: new Date(millis), id }
}

export const Route = createFileRoute('/api/calendar/notifications')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH']),

      GET: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') {
            return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const rawLimit = url.searchParams.get('limit')
          const parsed = listNotificationsRequestSchema.safeParse({
            ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
            ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
          })
          if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          // A cursor that fails to decode is rejected rather than silently treated as "first page":
          // silently restarting would make a paging client loop over the same rows forever.
          const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null
          if (parsed.data.cursor && !cursor) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const result = await withTenantContext(principal, async (tx) => ({
            page: await listOwnNotifications(tx, principal, { limit: parsed.data.limit, cursor }),
            unreadCount: await countOwnUnreadNotifications(tx, principal),
          }))

          return Response.json({
            deliveries: result.page.deliveries.map(({ createdAt, ...delivery }) => ({ ...delivery, createdAt })),
            nextCursor: result.page.nextCursor ? encodeCursor(result.page.nextCursor) : null,
            unreadCount: result.unreadCount,
          })
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
      PATCH: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') {
            return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const parsed = markNotificationsReadRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const result = await withTenantContext(principal, async (tx) => {
            const marked = await markOwnNotificationsRead(tx, principal, parsed.data.deliveryIds)
            return { ...marked, unreadCount: await countOwnUnreadNotifications(tx, principal) }
          })
          return Response.json(result)
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
    },
  },
})
