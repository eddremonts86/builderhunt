import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { handleSchema } from '~/shared/lib/self-managed/contracts'
import { isHandleAvailable } from '~/shared/lib/repositories/self-managed-profiles'

/**
 * Whether a handle may be taken right now, for the form that is about to try
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * Authenticated on purpose, although the answer describes public state: an availability endpoint is
 * an enumeration oracle by construction, and a session plus a per-user rate limit is what keeps it
 * a form helper rather than a directory scraper. The answer is availability *for this caller* —
 * their own reservation reads as available, because telling someone their own held handle is taken
 * would be absurd.
 */
export const Route = createFileRoute('/api/self-managed/handle/$handle/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const userId = session.user.id

          const limited = await rateLimit('self-managed-handle-lookup', userId, 30, 60)
          if (!limited.allowed) {
            return Response.json(
              { error: 'Too many handle lookups. Slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } },
            )
          }

          const handle = handleSchema.safeParse(params.handle)
          if (!handle.success) {
            return Response.json({ error: handle.error.issues[0]?.message ?? 'invalid handle' }, { status: 400 })
          }

          const available = await withAccountSubjectContext(userId, (transaction) =>
            isHandleAvailable(transaction, { handle: handle.data, forUserId: userId }))

          return Response.json({ handle: handle.data, available })
        } catch (error) {
          console.error('self-managed handle lookup error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
