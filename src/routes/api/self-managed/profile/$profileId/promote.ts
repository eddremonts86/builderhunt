import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { selfManagedDisabledResponse } from '~/shared/lib/self-managed/feature-flag'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { decideLink } from '~/shared/lib/human-identity/link-policy'
import {
  ownProfileDto,
  promoteToBuilderClaim,
  SelfManagedProfileError,
  unlinkBuilderClaim,
} from '~/shared/lib/repositories/self-managed-profiles'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

/**
 * Link a self-managed profile to a claim its owner has already proven, and unlink it again
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Additive, and reversible by construction
 *
 * Promotion writes one id. The profile keeps its handle, its words and its attachments, and gains a
 * verified block hydrated from the claim — which is why the reverse is a single `null` write and not
 * a restore. `getPublicProfileByHandle` already derives `verified` from the claim's own status by
 * join, so a claim revoked tomorrow stops backing this page tomorrow, with nothing to undo here.
 *
 * ## Confirmation is a field, and it is required
 *
 * `confirm: true` in the body. Not because a boolean stops anybody determined, but because this
 * endpoint attaches a *verified identity* to a page of self-declared content: the plan says
 * "explicit owner confirmation", and a request that cannot express intent cannot carry it. A
 * missing or false `confirm` is a 400, before the claim is even read.
 *
 * ## Nothing here can be talked into inferring
 *
 * The only accepted evidence is a claim id, and the decision runs through
 * `decideLink({ kind: 'verified_claim' })` — the module that exists because resemblance is not
 * evidence. There is no similarity parameter, no handle-matching branch and no threshold: a
 * `probabilistic` signal cannot even be constructed from this request body, which is a stronger
 * guarantee than checking a score and refusing it.
 */
const promoteSchema = z.object({
  claimId: z.string().min(1).max(64),
  /** Literal `true`. `false` is a refusal, and an absent field is a client that never asked. */
  confirm: z.literal(true),
}).strict()

export const Route = createFileRoute('/api/self-managed/profile/$profileId/promote')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST', 'DELETE']),

      POST: async ({ request, params }) => {
        try {
          const disabled = selfManagedDisabledResponse()
          if (disabled) return disabled
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id
          const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()

          const parsed = promoteSchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          const profile = await withAccountSubjectContext(ownerUserId, (transaction) =>
            promoteToBuilderClaim(transaction, {
              ownerUserId,
              profileId: params.profileId,
              claimId: parsed.data.claimId,
            }))

          /*
           * Recorded through the link policy rather than described in a string. The decision this
           * route just made *is* a `verified_claim` link, and routing it through the one module that
           * refuses to auto-link on similarity means a future "promote on a strong match" would have
           * to construct a signal that module rejects — rather than skipping a comment.
           */
          const decision = decideLink({ kind: 'verified_claim', claimId: parsed.data.claimId, subjectUserId: ownerUserId })

          await emitSecurityAudit({
            organizationId: null,
            actorUserId: ownerUserId,
            action: 'self-managed.profile.promote',
            targetType: 'self_managed_profile',
            targetId: params.profileId,
            result: 'allowed',
            requestId,
            // Identifiers and a method, never the profile's content.
            details: { claimId: parsed.data.claimId, method: decision.method, reviewState: decision.reviewState },
          }, consoleSecurityAuditSink)

          return Response.json({ profile: ownProfileDto(profile) })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) return refusalResponse(error)
          console.error('self-managed promote error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      DELETE: async ({ request, params }) => {
        try {
          const disabled = selfManagedDisabledResponse()
          if (disabled) return disabled
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const ownerUserId = session.user.id
          const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()

          const profile = await withAccountSubjectContext(ownerUserId, (transaction) =>
            unlinkBuilderClaim(transaction, { ownerUserId, profileId: params.profileId }))

          await emitSecurityAudit({
            organizationId: null,
            actorUserId: ownerUserId,
            action: 'self-managed.profile.unlink',
            targetType: 'self_managed_profile',
            targetId: params.profileId,
            result: 'allowed',
            requestId,
          }, consoleSecurityAuditSink)

          return Response.json({ profile: ownProfileDto(profile) })
        } catch (error) {
          if (error instanceof SelfManagedProfileError) return refusalResponse(error)
          console.error('self-managed unlink error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})

/** The repository's refusals, as statuses a client can act on. */
function refusalResponse(error: SelfManagedProfileError): Response {
  const status =
    error.code === 'not-found' || error.code === 'claim-not-found' ? 404
    : error.code === 'claim-not-verified' ? 409
    : 409
  return Response.json({ error: error.code }, { status })
}
