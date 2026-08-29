import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { handleSchema } from '~/shared/lib/self-managed/contracts'
import { reserveHandle, SelfManagedProfileError } from '~/shared/lib/repositories/self-managed-profiles'

/**
 * Hold a handle for seven days before the profile exists
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * Five a day per user, from the spec: a reservation costs its holder nothing, so the price of
 * squatting has to be the rate. The repository's `onConflictDoUpdate` guard is what stops a
 * reservation from taking over somebody else's live one; this route only decides who may ask.
 */
export const Route = createFileRoute('/api/self-managed/handle/$handle/reserve')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const userId = session.user.id

          const limited = await rateLimit('self-managed-handle-reserve', userId, 5, 24 * 60 * 60)
          if (!limited.allowed) {
            return Response.json(
              { error: 'Too many handle reservations today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } },
            )
          }

          // The handle arrives in the path, so it is client input like any body field.
          const handle = handleSchema.safeParse(params.handle)
          if (!handle.success) {
            return Response.json({ error: handle.error.issues[0]?.message ?? 'invalid handle' }, { status: 400 })
          }

          const reserved = await withAccountSubjectContext(userId, (transaction) =>
            reserveHandle(transaction, { handle: handle.data, userId }))

          return Response.json({ handle: reserved.handle, expiresAt: reserved.expiresAt.toISOString() })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) {
            return Response.json({ error: error.code }, { status: error.code === 'not-found' ? 404 : 409 })
          }
          console.error('self-managed handle reserve error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
