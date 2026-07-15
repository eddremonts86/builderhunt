import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders, builderClaimRequests } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomId, randomToken } from '~/lib/utils'
import { sendClaimEmail } from '~/shared/lib/email'
import { env } from '~/shared/lib/env'
import { z } from 'zod'

/**
 * Claim a builder profile.
 * POST /api/builders/:builderId/claim
 * Body: { email: string }
 */

const RATE_BUCKET = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000

function checkRate(ip: string): boolean {
  const now = Date.now()
  const b = RATE_BUCKET.get(ip)
  if (!b || b.resetAt < now) {
    RATE_BUCKET.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (b.count >= RATE_LIMIT) return false
  b.count++
  return true
}

const Body = z.object({ email: z.string().email() })

export const Route = createFileRoute('/api/builders/$builderId/claim')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
            ?? request.headers.get('x-real-ip')
            ?? 'unknown'
          if (!checkRate(ip)) {
            return Response.json({ error: 'Rate limit exceeded. Try again tomorrow.' }, { status: 429 })
          }

          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Valid email is required' }, { status: 400 })
          }
          const { email } = parsed.data
          const { builderId } = params

          const [builder] = await db
            .select({ id: builders.id, isClaimed: builders.isClaimed })
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!builder) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }
          if (builder.isClaimed) {
            return Response.json({ error: 'This profile is already claimed' }, { status: 409 })
          }

          const token = randomToken(32)
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
          await db.insert(builderClaimRequests).values({
            id: randomId(),
            builderId,
            email: email.toLowerCase(),
            token,
            expiresAt,
          })

          const siteUrl = env.APP_URL.replace(/\/$/, '')
          const link = `${siteUrl}/api/builders/claim/verify?token=${token}`
          const sendResult = await sendClaimEmail(email, link)

          if (!sendResult.ok) {
            console.error('Failed to send claim email:', sendResult.error)
            return Response.json({ error: 'Failed to send email' }, { status: 500 })
          }

          return Response.json({
            ok: true,
            message: 'Check your email for the verification link.',
            ...(sendResult.devLink ? { devLink: sendResult.devLink } : {}),
          })
        } catch (err) {
          console.error('Claim error:', err)
          return Response.json({ error: 'Failed to process claim' }, { status: 500 })
        }
      },
    },
  },
})
