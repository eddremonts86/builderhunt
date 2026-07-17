import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { z } from 'zod'

const PatchBody = z.object({
  topics: z.array(z.string().min(1).max(40)).max(20).optional(),
  country: z.string().min(2).max(60).nullable().optional(),
  language: z.string().min(2).max(40).nullable().optional(),
})

export const Route = createFileRoute('/api/builders/$builderId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ params }) => {
        // Public profile page (Plan: claimable-profiles, Phase 2) — no auth
        // required. Builder rows are a public directory once created; only
        // mutations (claim, edit, notes) are auth-gated.
        try {
          const { builderId } = params

          const [builder] = await db
            .select()
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!builder) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }

          return Response.json(builder)
        } catch (err) {
          console.error('Builder fetch error:', err)
          return Response.json({ error: 'Failed to fetch builder' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          // Validate body FIRST (so malformed payloads always get 400)
          const body = await request.json().catch(() => ({}))
          const parsed = PatchBody.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          // Only set fields that were provided
          const update: Record<string, unknown> = { updatedAt: new Date() }
          if (parsed.data.topics !== undefined) update.topics = parsed.data.topics
          if (parsed.data.country !== undefined) update.country = parsed.data.country
          if (parsed.data.language !== undefined) update.language = parsed.data.language

          if (Object.keys(update).length <= 1) {
            return Response.json({ error: 'No fields to update' }, { status: 400 })
          }

          // Then verify ownership
          const [existing] = await db
            .select({ id: builders.id, userId: builders.userId })
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!existing || existing.userId !== userId) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }

          const updated = await db
            .update(builders)
            .set(update)
            .where(eq(builders.id, builderId))
            .returning()

          return Response.json(updated[0] ?? { success: true })
        } catch (err) {
          console.error('Builder update error:', err)
          return Response.json({ error: 'Failed to update builder' }, { status: 500 })
        }
      },
    },
  },
})
