import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { toInvitationSummaryDto } from '~/shared/lib/organizations/contracts'

const Body = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'member']),
})

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
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          const invitation = await lifecycle.inviteMember(request, {
            organizationId: principal.organizationId,
            email: parsed.data.email,
            role: parsed.data.role,
          })
          // `devLink` is only ever present when no real email provider is
          // configured (dev mode) — the invitation was created but nothing
          // was actually sent, so the admin gets a manual-share fallback.
          return Response.json({ ...toInvitationSummaryDto(invitation), devLink: invitation.devLink })
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
