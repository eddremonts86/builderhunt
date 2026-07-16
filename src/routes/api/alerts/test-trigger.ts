import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { recordTrigger, evaluateMatch, type TriggerConditions } from '~/shared/lib/alerts'
import { db } from '~/shared/lib/db/index'
import { alerts } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomId } from '~/lib/utils'

const Body = z.object({
  alertId: z.string().optional(),
  alertName: z.string().optional(),
  builderId: z.string().optional(),
  builder: z.object({
    followersCount: z.number().optional(),
    topics: z.array(z.string()).optional(),
    bio: z.string().optional(),
  }).optional(),
  event: z.object({
    type: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  conditions: z.object({
    eventType: z.enum(['new_repo', 'new_product', 'keyword_match', 'any_activity']),
    minStars: z.number().optional(),
    minFollowers: z.number().optional(),
    keywords: z.array(z.string()).optional(),
    builderId: z.string().optional(),
  }),
})

// Test/dev-only endpoint: evaluate a match and record a trigger if it matches.
// Creates a placeholder alert on-the-fly if alertId isn't provided so the
// e2e tests don't have to set up a real alert first.
export const Route = createFileRoute('/api/alerts/test-trigger')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          let alertId = parsed.data.alertId
          if (!alertId) {
            // Auto-create a placeholder alert
            alertId = randomId()
            await db.insert(alerts).values({
              id: alertId,
              userId: session.user.id,
              name: parsed.data.alertName ?? 'Test alert',
              keywords: parsed.data.conditions.keywords ?? [],
              triggerConditions: parsed.data.conditions,
            })
          } else {
            // Verify alert exists for this user
            const [existing] = await db
              .select()
              .from(alerts)
              .where(eq(alerts.id, alertId))
              .limit(1)
            if (!existing || existing.userId !== session.user.id) {
              return Response.json({ error: 'Alert not found' }, { status: 404 })
            }
          }

          const matches = evaluateMatch(
            parsed.data.conditions as TriggerConditions,
            parsed.data.builder ?? {},
            parsed.data.event,
          )
          if (!matches) {
            return Response.json({ ok: true, matched: false })
          }
          const trigger = await recordTrigger({
            alertId,
            userId: session.user.id,
            builderId: parsed.data.builderId ?? null,
            eventType: parsed.data.event.type,
            payload: parsed.data.event.payload,
          })
          return Response.json({ ok: true, matched: true, trigger })
        } catch (err) {
          console.error('test trigger error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
