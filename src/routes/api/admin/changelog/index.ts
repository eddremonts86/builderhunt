import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'
import { createPlatformChangelog, listPlatformChangelog } from '~/shared/lib/repositories/platform-content'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers, and dashes only'),
  tags: z.array(z.string()).default([]),
})

function isAdmin(userId: string): boolean {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 100)
}

export const Route = createFileRoute('/api/admin/changelog/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const rows = await listPlatformChangelog()
          return Response.json(rows)
        } catch (err) {
          console.error('admin changelog list error:', err)
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
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          const slug = parsed.data.slug || slugify(parsed.data.title)
          const id = randomId()
          try {
            await createPlatformChangelog({
              id,
              title: parsed.data.title,
              content: parsed.data.content,
              slug,
              tags: parsed.data.tags,
            })
          } catch (err) {
            // DrizzleQueryError wraps the underlying Postgres error in `.cause`.
            // The wrapper's `.message` says "Failed query: ..." — not helpful.
            // Walk the chain to find the actual error.
            let cur: unknown = err
            let isDuplicate = false
            while (cur && typeof cur === 'object') {
              const m = (cur as { message?: string; code?: string }).message ?? ''
              const c = (cur as { code?: string }).code
              if (m.includes('duplicate key') || c === '23505') {
                isDuplicate = true
                break
              }
              cur = (cur as { cause?: unknown }).cause
            }
            if (isDuplicate) {
              return Response.json(
                { error: 'A changelog entry with that slug already exists.', slug },
                { status: 409 },
              )
            }
            throw err
          }
          return Response.json({ ok: true, id, slug })
        } catch (err) {
          console.error('admin changelog create error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
