import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { dataExportRequests } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { buildExportPayload, EXPORT_TTL_MS } from '~/shared/lib/legal'

const THROTTLE_MS = 24 * 60 * 60 * 1000

export const Route = createFileRoute('/api/me/data-export/')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })

          // Throttle: max 1 export per user per 24h
          const recent = await db
            .select()
            .from(dataExportRequests)
            .where(eq(dataExportRequests.userId, session.user.id))
          const lastReady = recent
            .filter((r) => r.status === 'ready')
            .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0]
          if (lastReady) {
            const ageMs = Date.now() - (lastReady.createdAt?.getTime() ?? 0)
            if (ageMs < THROTTLE_MS) {
              return Response.json(
                { error: 'Throttled. Try again in 24h.', existingId: lastReady.id },
                { status: 429 },
              )
            }
          }

          const id = crypto.randomUUID()
          await db.insert(dataExportRequests).values({
            id,
            userId: session.user.id,
            status: 'pending',
          })

          const payload = await buildExportPayload(session.user.id)
          if (!payload) {
            await db
              .update(dataExportRequests)
              .set({ status: 'failed' })
              .where(eq(dataExportRequests.id, id))
            return Response.json({ error: 'Failed' }, { status: 500 })
          }

          // Verify the payload is JSON-serializable before storing
          // (Drizzle objects can have circular refs)
          let safePayload: Record<string, unknown>
          try {
            safePayload = JSON.parse(JSON.stringify(payload))
          } catch (e) {
            console.error('data export serialize error:', e, 'payload keys:', payload ? Object.keys(payload) : 'null')
            await db
              .update(dataExportRequests)
              .set({ status: 'failed' })
              .where(eq(dataExportRequests.id, id))
            return Response.json({ error: 'Serialize failed' }, { status: 500 })
          }

          const expiresAt = new Date(Date.now() + EXPORT_TTL_MS)
          await db
            .update(dataExportRequests)
            .set({ status: 'ready', payload: safePayload, expiresAt })
            .where(eq(dataExportRequests.id, id))

          return Response.json({ ok: true, id })
        } catch (err) {
          console.error('data export error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const rows = await db
            .select()
            .from(dataExportRequests)
            .where(eq(dataExportRequests.userId, session.user.id))
          return Response.json(
            rows.map((r) => ({
              id: r.id,
              status: r.status,
              expiresAt: r.expiresAt,
              createdAt: r.createdAt,
              hasPayload: !!r.payload,
            })),
          )
        } catch (err) {
          console.error('data export list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
