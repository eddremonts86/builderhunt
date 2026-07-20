import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { randomId, randomToken } from '~/lib/utils'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { sendClaimEmail } from '~/shared/lib/email'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import {
  createPendingBuilderClaim,
  hashClaimSecret,
} from '~/shared/lib/repositories/builder-claims'

const Body = z.object({ email: z.string().email() })

export const Route = createFileRoute('/api/builders/$builderId/claim')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const session = await auth.api.getSession({ headers: request.headers })
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Valid email is required' }, { status: 400 })
          const email = parsed.data.email.toLowerCase()
          if (!session || session.user.email.toLowerCase() !== email) {
            return Response.json({ error: 'Use the email address of your signed-in account' }, { status: 403 })
          }
          const rl = await rateLimit(
            'builder-claim',
            `${principal.userId}:${params.builderId}`,
            5,
            24 * 60 * 60,
          )
          if (!rl.allowed) {
            return Response.json(
              { error: 'Rate limit exceeded. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }
          const token = randomToken(32)
          const claim = await withTenantContext(principal, (tx) => createPendingBuilderClaim(tx, {
            id: randomId(),
            builderIdentityId: params.builderId,
            subjectUserId: principal.userId,
            email,
            verificationSecretHash: hashClaimSecret(token),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }))
          if (!claim) return Response.json({ error: 'Builder not found' }, { status: 404 })
          const link = `${env.APP_URL.replace(/\/$/, '')}/api/builders/claim/verify?token=${encodeURIComponent(token)}`
          const sendResult = await sendClaimEmail(email, link)
          if (!sendResult.ok) return Response.json({ error: 'Failed to send email' }, { status: 500 })
          return Response.json({
            ok: true,
            message: 'Check your email for the verification link.',
            ...(sendResult.devLink ? { devLink: sendResult.devLink } : {}),
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (isUniqueViolation(error)) {
            return Response.json({ error: 'This profile already has an active claim' }, { status: 409 })
          }
          console.error('Claim error:', error)
          return Response.json({ error: 'Failed to process claim' }, { status: 500 })
        }
      },
    },
  },
})

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
