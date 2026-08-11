import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { randomToken } from '~/lib/utils'
import { auth } from '~/shared/lib/auth/better-auth'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getVerifiedBillingContact, setBillingContact } from '~/shared/lib/billing/billing-contact'
import { BillingAuthorizationError, canReadBillingSummary, requireBillingPermission } from '~/shared/lib/billing/permissions'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { sendBillingContactVerificationEmail } from '~/shared/lib/email'
import { env } from '~/shared/lib/env'

const SetContactBody = z.object({ email: z.string().email() }).strict()

/**
 * Verified billing contact (plans/implemented/30-stripe-billing-platform/tasks.md §9 task 4). GET is owner/admin
 * read-only (`billing:read`, matching the rest of the financial summary); PUT is owner + recent-auth
 * (`billing:contact`, matching payment-method-adjacent mutations) and starts a NEW verification —
 * the previous contact (verified or not) is immediately replaced.
 */
export const Route = createFileRoute('/api/billing/contact')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          if (!canReadBillingSummary(principal)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const contact = await withTenantContext(principal, (tx) => getVerifiedBillingContact(tx, principal.organizationId))
          return Response.json({ contact })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Billing contact read error:', error)
          return Response.json({ error: 'Failed to read billing contact' }, { status: 500 })
        }
      },
      PUT: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const authSession = await auth.api.getSession({ headers: request.headers })
          requireBillingPermission(
            principal,
            'billing:contact',
            authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined,
          )

          const parsed = SetContactBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          const verificationToken = randomToken(32)
          await withTenantContext(principal, (tx) => setBillingContact(tx, principal, authSession ? { authenticatedAt: new Date(authSession.session.createdAt) } : undefined, {
            email: parsed.data.email,
            verificationToken,
          }))

          const link = `${env.APP_URL.replace(/\/$/, '')}/api/billing/contact/verify?token=${encodeURIComponent(verificationToken)}`
          const sendResult = await sendBillingContactVerificationEmail(parsed.data.email, link)
          if (!sendResult.ok) return Response.json({ error: 'Failed to send verification email' }, { status: 500 })

          return Response.json({
            ok: true,
            message: 'Check the new address for a verification link.',
            ...(sendResult.devLink ? { devLink: sendResult.devLink } : {}),
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError || error instanceof BillingAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Billing contact set error:', error)
          return Response.json({ error: 'Failed to set billing contact' }, { status: 500 })
        }
      },
    },
  },
})
