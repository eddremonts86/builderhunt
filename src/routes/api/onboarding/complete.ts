import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { advanceOnboarding } from '~/shared/lib/onboarding'

const Body = z.object({
  step: z.number().int().min(0).max(3).optional(),
  firstQueryId: z.string().optional(),
  builderId: z.string().optional(),
  completed: z.boolean().optional(),
})

export const Route = createFileRoute('/api/onboarding/complete')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body' }, { status: 400 })
          }
          const status = await withTenantContext(principal, (tx) =>
            advanceOnboarding(tx, principal.organizationId, principal.userId, parsed.data))
          return Response.json({ ok: true, status })
        } catch (err) {
          if (err instanceof TenantAuthorizationError) {
            return Response.json({ error: err.message }, { status: err.status })
          }
          console.error('Onboarding complete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
