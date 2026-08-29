import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { setVisibilitySchema } from '~/shared/lib/self-managed/contracts'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import {
  getOwnProfile,
  ownProfileDto,
  SelfManagedProfileError,
  setVisibility,
} from '~/shared/lib/repositories/self-managed-profiles'

/**
 * Move the caller's profile between `draft`, `unlisted` and `public`
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * A separate route from the full update, because the surfaces are separate: a toggle in the header
 * should not have to send the whole profile back, and re-sending it is how a stale form silently
 * reverts an edit made in another tab.
 *
 * The change is audited with the transition and nothing else — what moved from `draft` to `public`
 * is a fact worth keeping, what the bio says is content the audit log must never hold.
 */
export const Route = createFileRoute('/api/self-managed/visibility')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id
          const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()

          const parsed = setVisibilitySchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          const result = await withAccountSubjectContext(ownerUserId, async (transaction) => {
            const existing = await getOwnProfile(transaction, ownerUserId)
            if (!existing) return null
            const updated = await setVisibility(transaction, { ownerUserId, visibility: parsed.data.visibility })
            return { from: existing.visibility, updated }
          })

          if (!result) return Response.json({ error: 'not_found' }, { status: 404 })

          await emitSecurityAudit({
            organizationId: null,
            actorUserId: ownerUserId,
            action: 'self-managed.profile.visibility',
            targetType: 'self_managed_profile',
            targetId: result.updated.id,
            result: 'allowed',
            requestId,
            details: { from: result.from, to: result.updated.visibility },
          }, consoleSecurityAuditSink)

          return Response.json({ profile: ownProfileDto(result.updated) })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) {
            return Response.json({ error: error.code }, { status: error.code === 'not-found' ? 404 : 409 })
          }
          console.error('self-managed visibility error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
