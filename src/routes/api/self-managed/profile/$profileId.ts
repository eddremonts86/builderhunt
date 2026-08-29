import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { upsertSelfManagedProfileSchema } from '~/shared/lib/self-managed/contracts'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import {
  getOwnProfile,
  ownProfileDto,
  SelfManagedProfileError,
  softDeleteProfile,
  updateProfile,
} from '~/shared/lib/repositories/self-managed-profiles'

/**
 * Edit or delete one profile — the caller's own, addressed by id
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## The id is checked, never obeyed
 *
 * Both handlers resolve *the caller's own* profile and compare its id to the path. A stranger's
 * profile id — or one that never existed — answers the same 404 either way, so the route cannot be
 * used to confirm that an id exists. The repository takes `ownerUserId` and nothing else; the path
 * id is a claim to verify, not an instruction to follow.
 *
 * ## Update is a full replacement
 *
 * `upsertSelfManagedProfileSchema`, same as create: a partial patch over a form that renders every
 * field makes an omitted key ambiguous between "unchanged" and "cleared".
 */
export const Route = createFileRoute('/api/self-managed/profile/$profileId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH', 'DELETE']),

      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id

          const parsed = upsertSelfManagedProfileSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          const updated = await withAccountSubjectContext(ownerUserId, async (transaction) => {
            const own = await getOwnProfile(transaction, ownerUserId)
            // One answer for absent, deleted, and somebody else's: the id in the path either names
            // the caller's own live profile or it names nothing.
            if (!own || own.id !== params.profileId) return null
            return updateProfile(transaction, { ownerUserId, profile: parsed.data })
          })

          if (!updated) return Response.json({ error: 'not_found' }, { status: 404 })
          return Response.json({ profile: ownProfileDto(updated) })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) return refusalResponse(error)
          console.error('self-managed profile update error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      DELETE: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id
          const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()

          const deleted = await withAccountSubjectContext(ownerUserId, async (transaction) => {
            const own = await getOwnProfile(transaction, ownerUserId)
            if (!own || own.id !== params.profileId) return false
            return softDeleteProfile(transaction, { ownerUserId })
          })

          if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 })

          // A material change to what the world can see, recorded without recording the content.
          await emitSecurityAudit({
            organizationId: null,
            actorUserId: ownerUserId,
            action: 'self-managed.profile.delete',
            targetType: 'self_managed_profile',
            targetId: params.profileId,
            result: 'allowed',
            requestId,
          }, consoleSecurityAuditSink)

          return Response.json({ deleted: true })
        } catch (error) {
          console.error('self-managed profile delete error:', (error as Error)?.name)
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
