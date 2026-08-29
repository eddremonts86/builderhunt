import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { selfManagedDisabledResponse } from '~/shared/lib/self-managed/feature-flag'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { upsertSelfManagedProfileSchema } from '~/shared/lib/self-managed/contracts'
import { syncSelfManagedProfileIndex } from '~/lib/semantic/self-managed-index'
import {
  createProfile,
  getOwnProfile,
  ownProfileDto,
  SelfManagedProfileError,
} from '~/shared/lib/repositories/self-managed-profiles'

/**
 * The owner's own profile: read it, create it (plan: phase-2/07-perfiles-autogestionados,
 * "Expose strict owner and public profile APIs").
 *
 * ## Account-subject, like the attachment routes
 *
 * The guard is the session and the context sets `app.user_id` alone — a profile belongs to a
 * person, and a builder without an active organization must still be able to create one. The owner
 * comes from the session and never from the body: `upsertSelfManagedProfileSchema` is `.strict()`
 * and carries no subject field to lie in.
 *
 * ## Creation is rate-limited as well as unique
 *
 * One live profile per account is the constraint; the limit is for the churn around it — a loop of
 * create/delete/create is how handles get farmed and how the thirty-day handle hold gets probed.
 * Ten a day is far above any honest use and far below a useful abuse rate.
 */
export const Route = createFileRoute('/api/self-managed/profile/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const disabled = selfManagedDisabledResponse()
          if (disabled) return disabled
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const profile = await withAccountSubjectContext(ownerUserId, (transaction) =>
            getOwnProfile(transaction, ownerUserId))

          if (!profile) return Response.json({ error: 'not_found' }, { status: 404 })
          return Response.json({ profile: ownProfileDto(profile) })
        } catch (error) {
          console.error('self-managed profile read error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const disabled = selfManagedDisabledResponse()
          if (disabled) return disabled
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const limited = await rateLimit('self-managed-profile-create', ownerUserId, 10, 24 * 60 * 60)
          if (!limited.allowed) {
            return Response.json(
              { error: 'Too many profile creations today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } },
            )
          }

          const parsed = upsertSelfManagedProfileSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          const profile = await withAccountSubjectContext(ownerUserId, (transaction) =>
            createProfile(transaction, { ownerUserId, profile: parsed.data }))

          // Fire-and-forget, off the response path: a slow or failed index write must not make
          // creating a profile slow or fail. The nightly reconciliation is what catches the miss.
          void syncSelfManagedProfileIndex(profile.id)

          return Response.json({ profile: ownProfileDto(profile) })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) return refusalResponse(error)
          console.error('self-managed profile create error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})

/** The refusals the repository names, mapped to statuses a client can act on. */
function refusalResponse(error: SelfManagedProfileError): Response {
  return Response.json({ error: error.code }, { status: error.code === 'not-found' ? 404 : 409 })
}
