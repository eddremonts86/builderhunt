import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { sendDeletionScheduledEmail } from '~/shared/lib/email'
import {
  AccountDeletionOwnershipError,
  cancelDeletion,
  getDeletionRequest,
  requestDeletion,
} from '~/shared/lib/legal'

export const Route = createFileRoute('/api/me/delete-account/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ request: null })
          const row = await getDeletionRequest(session.user.id)
          return Response.json({ request: row })
        } catch (err) {
          console.error('get deletion error:', err)
          return Response.json({ request: null })
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const result = await requestDeletion(session.user.id)
          // sendDeletionScheduledEmail already logs-and-returns when Resend is
          // unconfigured (same no-cost fallback as every other sender in email.ts).
          const sent = await sendDeletionScheduledEmail(session.user.email, result.gracePeriodEndsAt)
          if (!sent.ok) {
            console.error('[legal] deletion-scheduled email failed:', sent.error)
          }
          return Response.json({ ok: true, ...result })
        } catch (err) {
          if (err instanceof AccountDeletionOwnershipError) {
            return Response.json({ error: err.message, organizations: err.organizations }, { status: err.status })
          }
          console.error('delete account error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const [cancelled] = await cancelDeletion(session.user.id)
          return Response.json({ ok: true, requestId: cancelled?.id ?? null })
        } catch (err) {
          console.error('cancel deletion error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
