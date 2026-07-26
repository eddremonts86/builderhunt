import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { getRateLimitId, rateLimit } from '~/shared/lib/rate-limit'
import { env } from '~/shared/lib/env'
import { requestProfileRemoval } from '~/shared/lib/profile-removal'

const RequestBody = z.object({
  profileUrl: z.string().min(1).max(500),
  requesterEmail: z.string().email().optional(),
})

/**
 * Starts a profile-removal request (plan: audit-trust). Unauthenticated by design — the person
 * asking to be removed need not have (or want) a BuilderHunt account. Rate-limited by IP and by
 * IP+profile so one visitor can't mint unlimited challenges for arbitrary or a single profile.
 *
 * Always responds 202 with the same shape for a syntactically valid, source-supported URL,
 * regardless of whether that identity exists in our data yet or already has a pending/verified
 * request — spec.md: "the same 202 response for existing/pending/unknown identities to limit
 * enumeration."
 */
export const Route = createFileRoute('/api/privacy/profile-removal')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (env.PROFILE_REMOVAL_ENABLED === 'false') {
            return Response.json({ error: 'Profile removal is temporarily unavailable' }, { status: 503 })
          }

          const parsed = RequestBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const ip = getRateLimitId(request)
          const ipLimit = await rateLimit('profile-removal-request-ip', ip, 20, 60 * 60)
          if (!ipLimit.allowed) {
            return Response.json(
              { error: 'Too many requests. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(ipLimit.resetMs / 1000)) } },
            )
          }
          const profileKey = `${ip}:${parsed.data.profileUrl.toLowerCase().trim()}`
          const profileLimit = await rateLimit('profile-removal-request-profile', profileKey, 5, 60 * 60)
          if (!profileLimit.allowed) {
            return Response.json(
              { error: 'Too many requests for this profile. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(profileLimit.resetMs / 1000)) } },
            )
          }

          const result = await requestProfileRemoval({
            profileUrl: parsed.data.profileUrl,
            requesterEmail: parsed.data.requesterEmail ?? null,
          })

          if (result.kind === 'invalid_url') {
            return Response.json({ error: 'Enter a profile URL from a supported source (GitHub, GitLab, Codeberg, or DEV.to).' }, { status: 400 })
          }
          if (result.kind === 'unsupported') {
            return Response.json({
              ok: true,
              manualReview: true,
              message: 'Automated verification is not yet available for this source. Contact privacy@builderhunt.dev with the profile link and we will review it manually.',
            }, { status: 202 })
          }

          return Response.json({
            ok: true,
            requestId: result.requestId,
            challenge: result.challenge,
            instructions: result.instructions,
            expiresAt: result.expiresAt,
          }, { status: 202 })
        } catch (error) {
          console.error('Profile removal request error:', error)
          return Response.json({ error: 'Failed to process removal request' }, { status: 500 })
        }
      },
    },
  },
})
