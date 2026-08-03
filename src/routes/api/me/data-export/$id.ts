import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { findAccountExportRequest } from '~/shared/lib/repositories/account-privacy'

export const Route = createFileRoute('/api/me/data-export/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const row = await findAccountExportRequest(session.user.id, params.id)
          if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
          if (row.status !== 'ready' || !row.payload) {
            return Response.json({ id: row.id, status: row.status })
          }
          // Expired? Mark and return 410
          if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
            return Response.json({ id: row.id, status: 'expired' }, { status: 410 })
          }
          return Response.json({
            id: row.id,
            status: row.status,
            payload: row.payload,
            expiresAt: row.expiresAt,
          })
        } catch (err) {
          console.error('data export get error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
