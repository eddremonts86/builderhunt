import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { getRateLimitId, rateLimit } from '~/shared/lib/rate-limit'
import { env } from '~/shared/lib/env'
import { verifyProfileRemoval } from '~/shared/lib/profile-removal'

const VerifyBody = z.object({
  requestId: z.string().min(1),
  challenge: z.string().min(1).max(200),
})

/**
 * Confirms a profile-removal challenge (plan: audit-trust). Unauthenticated: possessing the
 * exact `{requestId, challenge}` pair IS the authorization — see profile-removal.ts's module
 * comment for why matching the challenge's hash is a sufficient capability check on its own.
 * Checking the source's live bio for the challenge is the expensive/abusable step here, so it
 * gets its own, tighter rate limit independent of the request endpoint's.
 */
export const Route = createFileRoute('/api/privacy/profile-removal/verify')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          if (env.PROFILE_REMOVAL_ENABLED === 'false') {
            return Response.json({ error: 'Profile removal is temporarily unavailable' }, { status: 503 })
          }

          const parsed = VerifyBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const ip = getRateLimitId(request)
          const rl = await rateLimit('profile-removal-verify', `${ip}:${parsed.data.requestId}`, 10, 60 * 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many attempts. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const result = await verifyProfileRemoval({
            requestId: parsed.data.requestId,
            challenge: parsed.data.challenge,
          })

          switch (result.kind) {
            case 'not_found':
              return Response.json({ error: 'not_found' }, { status: 404 })
            case 'expired':
              return Response.json({ error: 'expired' }, { status: 410 })
            case 'invalid_challenge':
              return Response.json({ error: 'invalid_challenge' }, { status: 422 })
            case 'proof_failed':
              return Response.json({ error: result.reason }, { status: 422 })
            case 'verified':
              return Response.json({ ok: true })
          }
        } catch (error) {
          console.error('Profile removal verify error:', error)
          return Response.json({ error: 'Failed to verify removal request' }, { status: 500 })
        }
      },
    },
  },
})
