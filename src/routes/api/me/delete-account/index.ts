import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
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
          // In dev: log the "email" to console (no Resend)
          console.log(
            `[legal] Account deletion ${result.alreadyPending ? 'already pending' : 'requested'} ` +
            `for user ${session.user.id}. Grace ends ${result.gracePeriodEndsAt.toISOString()}. ` +
            `Cancel: /dashboard/settings/privacy`,
          )
          return Response.json({ ok: true, ...result })
        } catch (err) {
          if (err instanceof AccountDeletionOwnershipError) {
            return Response.json({ error: err.message, organizationIds: err.organizationIds }, { status: err.status })
          }
          console.error('delete account error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          await cancelDeletion(session.user.id)
          return Response.json({ ok: true })
        } catch (err) {
          console.error('cancel deletion error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
