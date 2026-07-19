import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'
import { z } from 'zod'

const TrackBody = z.object({
  source: z.enum([
    'github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow',
    'npm', 'huggingface', 'gitlab', 'codeberg', 'hashnode', 'sourcehut',
  ]),
  sourceId: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  profileUrl: z.string().min(1),
  followersCount: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const Route = createFileRoute('/api/builders/track')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const body = await request.json().catch(() => ({}))
          const parsed = TrackBody.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          const data = parsed.data

          const [existing] = await db
            .select({ id: builders.id })
            .from(builders)
            .where(
              and(
                eq(builders.userId, userId),
                eq(builders.source, data.source),
                eq(builders.sourceId, data.sourceId),
              ),
            )
            .limit(1)

          if (!existing) {
            const { checkLimit } = await import('~/shared/lib/billing')
            const limit = await checkLimit(userId, 'savedBuilders')
            if (!limit.allowed) {
              return Response.json(
                {
                  error: `You've reached the ${limit.plan} plan limit of ${limit.limit} saved builders. Upgrade to save more.`,
                  limit: limit.limit,
                  current: limit.current,
                  plan: limit.plan,
                  upgradeUrl: '/pricing',
                },
                { status: 402 },
              )
            }
          }

          const id = existing?.id ?? randomId()
          const [row] = await db
            .insert(builders)
            .values({
              id,
              userId,
              source: data.source,
              sourceId: data.sourceId,
              username: data.username,
              displayName: data.displayName ?? null,
              avatarUrl: data.avatarUrl ?? null,
              bio: data.bio ?? null,
              profileUrl: data.profileUrl,
              followersCount: data.followersCount ?? 0,
              language: data.language ?? null,
              country: data.country ?? null,
              topics: data.topics ?? [],
              metadata: { ...(data.metadata ?? {}), score: data.score ?? null },
            })
            .onConflictDoUpdate({
              target: [builders.userId, builders.source, builders.sourceId],
              set: { lastSeen: new Date(), updatedAt: new Date() },
            })
            .returning()

          return Response.json({ id: row.id, tracked: true })
        } catch (err) {
          console.error('Track builder error:', err)
          return Response.json({ error: 'Failed to track builder' }, { status: 500 })
        }
      },
    },
  },
})
