import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { db } from '~/shared/lib/db/index'
import { alerts } from '~/shared/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'
import { rateLimit } from '~/shared/lib/rate-limit'

/**
 * CRUD for smart alerts. Previously missing entirely — the matcher/worker
 * and the /alerts inbox existed, but there was no way for a user to
 * actually create an alert with trigger conditions (only a dev-only
 * `/api/alerts/test-trigger` endpoint that auto-created a placeholder).
 */

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  keywords: z.array(z.string()).default([]),
  frequency: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
  deliveryChannel: z.enum(['email', 'dashboard']).default('email'),
  triggerConditions: z.object({
    eventType: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    minStars: z.number().min(0).optional(),
    minFollowers: z.number().min(0).optional(),
    keywords: z.array(z.string()).optional(),
    builderId: z.string().optional(),
  }),
})

export const Route = createFileRoute('/api/alerts/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const rows = await db
            .select()
            .from(alerts)
            .where(eq(alerts.userId, session.user.id))
            .orderBy(desc(alerts.createdAt))
          return Response.json(rows)
        } catch (err) {
          console.error('alerts list error:', err)
          return Response.json({ error: 'Failed to fetch alerts' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const userId = session.user.id

          const rl = await rateLimit('alert-create', userId, 20, 24 * 60 * 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many alerts created today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const body = await request.json().catch(() => ({}))
          const parsed = CreateBody.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid alert', details: parsed.error.flatten() }, { status: 400 })
          }

          // Pro+ gate — smart alerts (trigger conditions beyond a plain
          // keyword digest) are a paid-plan feature per the pricing plan.
          const { getUserPlan } = await import('~/shared/lib/billing')
          const plan = await getUserPlan(userId)
          if ((plan?.plan ?? 'free') === 'free') {
            return Response.json(
              { error: 'Smart alerts are a Pro feature. Upgrade to create alerts.', upgradeUrl: '/pricing' },
              { status: 402 },
            )
          }

          const [row] = await db
            .insert(alerts)
            .values({
              id: randomId(),
              userId,
              name: parsed.data.name.trim(),
              keywords: parsed.data.keywords,
              frequency: parsed.data.frequency,
              deliveryChannel: parsed.data.deliveryChannel,
              triggerConditions: parsed.data.triggerConditions,
              enabled: true,
            })
            .returning()

          return Response.json(row)
        } catch (err) {
          console.error('alerts create error:', err)
          return Response.json({ error: 'Failed to create alert' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const body = await request.json().catch(() => ({}))
          const { id } = body as { id?: string }
          if (!id) return Response.json({ error: 'id is required' }, { status: 400 })

          const result = await db
            .delete(alerts)
            .where(and(eq(alerts.id, id), eq(alerts.userId, session.user.id)))
            .returning({ id: alerts.id })
          if (result.length === 0) {
            return Response.json({ error: 'Alert not found or not yours' }, { status: 404 })
          }
          return Response.json({ success: true })
        } catch (err) {
          console.error('alerts delete error:', err)
          return Response.json({ error: 'Failed to delete alert' }, { status: 500 })
        }
      },
    },
  },
})
