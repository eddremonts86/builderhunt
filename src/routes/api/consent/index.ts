import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '~/shared/lib/db/index'
import { userConsents } from '~/shared/lib/db/schema'
import { and, eq, desc } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'

const CURRENT_VERSIONS = {
  tos: 'v1.0',
  privacy: 'v1.0',
  cookies: 'v1.0',
}

const ConsentBody = z.object({
  document: z.enum(['tos', 'privacy', 'cookies']),
  version: z.string().min(1),
})

export const Route = createFileRoute('/api/consent/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({
              userId: null,
              consents: {},
              required: CURRENT_VERSIONS,
              needsAcceptance: [],
            })
          }
          const rows = await db
            .select()
            .from(userConsents)
            .where(eq(userConsents.userId, session.user.id))
            .orderBy(desc(userConsents.acceptedAt))
          // Keep latest consent per document
          const map: Record<string, string> = {}
          for (const r of rows) {
            if (!map[r.document]) map[r.document] = r.version
          }
          const needsAcceptance: string[] = []
          for (const [doc, ver] of Object.entries(CURRENT_VERSIONS)) {
            if (map[doc] !== ver) needsAcceptance.push(doc)
          }
          return Response.json({
            userId: session.user.id,
            consents: map,
            required: CURRENT_VERSIONS,
            needsAcceptance,
          })
        } catch (err) {
          console.error('consent status error:', err)
          return Response.json({
            userId: null,
            consents: {},
            required: CURRENT_VERSIONS,
            needsAcceptance: [],
          })
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const body = await request.json().catch(() => ({}))
          const parsed = ConsentBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          await db.insert(userConsents).values({
            id: randomId(),
            userId: session.user.id,
            document: parsed.data.document,
            version: parsed.data.version,
          })
          return Response.json({ ok: true })
        } catch (err) {
          console.error('consent post error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
