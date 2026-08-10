import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { toInvitationSummaryDto } from '~/shared/lib/organizations/contracts'
import { INVITATION_INTENTS, ROLE_TITLE_MAX_LENGTH } from '~/shared/lib/organizations/invitation-personalization'

/**
 * `.strict()` is the point of this schema, not the field list.
 *
 * An unknown key is a rejected request rather than an ignored one, so a client that sends
 * `organizationId` or `inviterId` gets a 400 instead of the quiet reassurance that its field was
 * accepted. The organization is derived from the caller's own session below and never from the body.
 *
 * `intent` and `roleTitle` are optional so every client that predates plan 59 keeps working; the
 * lifecycle normalizes an omitted intent to `other`. The 120-character bound is
 * `ROLE_TITLE_MAX_LENGTH`, one constant shared with the CHECK constraint in migration 0165 — a route
 * that accepted 121 would hand the database a row it answers with a 500.
 */
const Body = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'member']),
  intent: z.enum(INVITATION_INTENTS).optional(),
  roleTitle: z.string().trim().min(1).max(ROLE_TITLE_MAX_LENGTH).nullish(),
}).strict()

export const Route = createFileRoute('/api/organizations/invitations/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      // The organization invited into always comes from the caller's own
      // session (`requireTenantPrincipal`), never the request body.
      POST: async ({ request }) => {
        try {
          // Authenticate before validating. A stranger must not be able to tell a real endpoint from an absent
          // one by the shape of its complaint: parsing first answers 400 "Invalid body" to an anonymous caller,
          // which confirms the route exists and hints at its schema, where 401 reveals nothing. Same ordering fix
          // as `organizations/index.ts`.
          const principal = await requireTenantPrincipal(request)
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const lifecycle = await getOrganizationLifecycle()
          const invitation = await lifecycle.inviteMember(request, {
            organizationId: principal.organizationId,
            email: parsed.data.email,
            role: parsed.data.role,
            intent: parsed.data.intent,
            roleTitle: parsed.data.roleTitle,
          })
          // `devLink` is only ever present when no real email provider is
          // configured (dev mode) — the invitation was created but nothing
          // was actually sent, so the admin gets a manual-share fallback.
          //
          // `deduplicated` tells the sender's UI that a pending invitation already existed, so it can
          // say their new context was not applied instead of reporting a freshly sent invitation. The
          // winning row is returned either way, which is why the response alone cannot distinguish them.
          return Response.json({
            ...toInvitationSummaryDto(invitation),
            devLink: invitation.devLink,
            deduplicated: invitation.deduplicated,
          })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Invitation create error:', error)
          return Response.json({ error: 'Failed to send invitation' }, { status: 500 })
        }
      },
    },
  },
})

function lifecycleErrorResponse(error: unknown) {
  if (error instanceof OrganizationLifecycleError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return null
}
