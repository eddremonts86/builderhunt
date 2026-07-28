import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { getOrganizationLifecycle, OrganizationLifecycleError } from '~/shared/lib/auth/organization-lifecycle'
import { findAccountEmailAndName, findOrganizationName } from '~/shared/lib/repositories/account-privacy'
import { sendOwnershipTransferredFromEmail, sendOwnershipTransferredToEmail } from '~/shared/lib/email'

const Body = z.object({
  targetUserId: z.string().min(1),
})

export const Route = createFileRoute('/api/organizations/transfer-ownership')({
  component: () => null,
  server: {
    handlers: {
      // The organization being acted on always comes from the caller's own
      // session (`requireTenantPrincipal`), never from the request body —
      // only the target member id is client-supplied, and the lifecycle
      // service itself re-validates that target belongs to that same org.
      POST: async ({ request }) => {
        try {
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const principal = await requireTenantPrincipal(request)
          const lifecycle = await getOrganizationLifecycle()
          const result = await lifecycle.transferOwnership(request, principal.organizationId, parsed.data.targetUserId)

          // Best-effort — the transfer itself already committed; a notification failure never
          // reverses it or fails this request (plans/phase-1/29-stripe-billing-platform/tasks.md §9 task 5:
          // "notify both parties", not "notification must succeed for the transfer to count").
          notifyOwnershipTransfer(principal.organizationId, principal.userId, parsed.data.targetUserId).catch((error) => {
            console.error('Ownership transfer notification error:', error)
          })

          return Response.json({ ok: true, requestId: result.requestId })
        } catch (error) {
          const response = lifecycleErrorResponse(error)
          if (response) return response
          console.error('Ownership transfer error:', error)
          return Response.json({ error: 'Failed to transfer ownership' }, { status: 500 })
        }
      },
    },
  },
})

async function notifyOwnershipTransfer(organizationId: string, previousOwnerId: string, newOwnerId: string): Promise<void> {
  const [organizationName, previousOwner, newOwner] = await Promise.all([
    findOrganizationName(organizationId),
    findAccountEmailAndName(previousOwnerId),
    findAccountEmailAndName(newOwnerId),
  ])
  const orgName = organizationName ?? 'your organization'
  await Promise.all([
    previousOwner ? sendOwnershipTransferredFromEmail(previousOwner.email, orgName, newOwner?.name ?? 'the new owner') : Promise.resolve(),
    newOwner ? sendOwnershipTransferredToEmail(newOwner.email, orgName, previousOwner?.name ?? 'the previous owner') : Promise.resolve(),
  ])
}

function lifecycleErrorResponse(error: unknown) {
  if (error instanceof OrganizationLifecycleError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return null
}
