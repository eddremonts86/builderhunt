import { createFileRoute } from '@tanstack/react-router'
import { invitationAuditDetails, markInvitationSent } from '~/lib/scheduling/invitation-service'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { sendInterviewInvitationEmail } from '~/shared/lib/email'
import { invitationStateChangeRequestSchema } from '~/shared/lib/interview-api'
import { findOrganizationDisplayName } from '~/shared/lib/repositories/scheduling'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'
import { invitationFailureResponse, schedulingDisabledResponse } from '../index'

/**
 * Marks an invitation sent (plan: calendar-scheduling-interview-intelligence, Phase 5).
 *
 * The request carries the version the organizer's UI was showing, so a send racing another tab's
 * revoke loses with `409` instead of resurrecting a revoked invitation. A second send is refused
 * with `already_sent`: the capability is minted here and only its hash is kept, so there is no link
 * to re-emit and minting a replacement would orphan the one already in the candidate's inbox.
 *
 * **The email is sent inside the transaction, not queued.** The obvious alternative — an outbox row
 * committed with the status, drained by a worker — cannot work here, because the row would have to
 * carry the link, which means carrying the secret in a table. That is exactly what minting-at-send
 * exists to avoid. So delivery is synchronous and a provider failure throws, rolling the status back
 * to `draft` for the organizer to retry. This follows the same direct-send shape organization
 * invitations already use in `auth/organization-lifecycle.ts`.
 *
 * **Without an email provider the response carries the link.** `devLink` is present only when
 * `RESEND_API_KEY` is unset — the sender returns nothing otherwise, so the field cannot appear in an
 * environment that can deliver mail. It exists because the secret is minted here and never stored: before
 * this, a local or preview environment produced an invitation that was `sent`, had its hash committed, and
 * whose only copy of the link went to a server console. The organizer had no way to obtain it and no way
 * to re-send, so every such invitation was dead on arrival and the candidate page showed the ordinary
 * "no longer open" message with no way to tell that from a genuine revocation.
 *
 * The residual risk is the dual-write one: the provider accepts the mail and the commit then fails,
 * so a candidate holds a link whose hash was never stored. They see the ordinary "no longer open"
 * page, the invitation is still a draft, and sending again mints a fresh secret that works — the
 * failure is visible and recoverable rather than silent.
 */
class InvitationDeliveryError extends Error {
  constructor(readonly reason: 'no_recipient' | 'provider_failed', detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'InvitationDeliveryError'
  }
}

export const Route = createFileRoute('/api/scheduling/invitations/$invitationId/send')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (env.SCHEDULING_ENABLED === 'false') return schedulingDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = invitationStateChangeRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await withTenantContext(principal, async (tx) => {
            const sent = await markInvitationSent(tx, principal, params.invitationId, parsed.data.version)
            if (!sent.ok) return sent

            const recipient = sent.value.invitation.candidateEmailNormalized
            if (!recipient) {
              // Nothing to send to. Refused rather than committed, so the organizer does not end up
              // with a `sent` invitation nobody was ever told about.
              throw new InvitationDeliveryError('no_recipient')
            }

            // The secret goes in the fragment, so it never reaches a server log or a Referer header.
            const link = `${env.APP_URL.replace(/\/$/, '')}/schedule/${sent.value.invitation.id}#${sent.value.capabilitySecret}`
            const delivery = await sendInterviewInvitationEmail({
              to: recipient,
              roleTitle: sent.value.invitation.roleTitle,
              organizationName: await findOrganizationDisplayName(tx, principal.organizationId) ?? 'A team on BuilderHunt',
              durationMinutes: sent.value.invitation.durationMinutes,
              link,
              expiresAt: sent.value.invitation.expiresAt,
            })
            // Throwing unwinds the transaction: the status returns to `draft` and the hash we just
            // wrote goes with it, so no invitation is left claiming to have been sent.
            if (!delivery.ok) throw new InvitationDeliveryError('provider_failed', delivery.error)
            // Carried out of the transaction so the response can show it. Present only when no email
            // provider is configured — see the `devLink` note on the response below.
            return { ...sent, value: { ...sent.value, devLink: delivery.devLink ?? null } }
          })
          if (!result.ok) return invitationFailureResponse(result)

          await emitSecurityAudit({
            organizationId: principal.organizationId,
            actorUserId: principal.userId,
            action: 'scheduling.invitation.sent',
            targetType: 'scheduling_invitation',
            targetId: result.value.invitation.id,
            result: 'allowed',
            requestId: principal.requestId,
            details: invitationAuditDetails(result.value.invitation),
          }, consoleSecurityAuditSink)

          return Response.json({
            invitationId: result.value.invitation.id,
            status: result.value.invitation.status,
            version: result.value.invitation.version,
            /**
             * The candidate link, **only when no email provider is configured**.
             *
             * `sendInterviewInvitationEmail` returns `devLink` when `RESEND_API_KEY` is unset and nothing
             * at all when it is set, so this field is structurally absent in any environment that can
             * actually deliver mail. It is not a convenience: the secret is minted here and only its hash
             * is stored, so without this the response was the last moment the link existed and it was
             * discarded — every invitation created in a local or preview environment was dead on arrival
             * and irrecoverable, with the only copy printed to a server console nobody was watching.
             */
            devLink: result.value.devLink,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: 'authentication_required' }, { status: 401 })
          }
          if (error instanceof InvitationDeliveryError) {
            // The transaction is already unwound, so the invitation is still a draft and can be sent
            // again. `502` for a provider failure because the fault is downstream, not in the
            // request; `422` for a missing address because the request can never succeed as it is.
            console.error('scheduling invitation delivery failed:', error.message)
            return error.reason === 'no_recipient'
              ? Response.json({
                error: 'no_recipient',
                message: 'This invitation has no candidate email address to send to.',
              }, { status: 422 })
              : Response.json({
                error: 'delivery_failed',
                message: 'The invitation could not be emailed. It is still a draft — try sending it again.',
              }, { status: 502 })
          }
          console.error('scheduling invitation send route error:', error)
          return Response.json({ error: 'invalid_input' }, { status: 400 })
        }
      },
    },
  },
})
