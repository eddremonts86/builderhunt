import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'
import { createPlatformIncident, listPlatformIncidents } from '~/shared/lib/repositories/platform-content'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  severity: z.enum(['minor', 'major', 'critical']).default('minor'),
  affectedComponents: z.array(z.string()).default([]),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/incidents/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const rows = await listPlatformIncidents()
          return Response.json(rows)
        } catch (err) {
          console.error('admin incidents list error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = CreateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const id = randomId()
          await createPlatformIncident({
            id,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            severity: parsed.data.severity,
            affectedComponents: parsed.data.affectedComponents,
          })
          return Response.json({ ok: true, id })
        } catch (err) {
          console.error('admin incident create error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
