import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { updateVerifiedBuilderProfile } from '~/shared/lib/repositories/builder-claims'

const Body = z.object({
  claimedTopics: z.array(z.string().min(1).max(40)).max(20).optional(),
  openToStatus: z.array(z.enum(['chats', 'mentoring', 'collaboration', 'hires', 'consulting', 'nothing'])).max(6).optional(),
  bio: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/me/builder/$builderId')({
  component: () => null,
  server: {
    handlers: {
      /**
       * A `GET` here used to answer **200 with an HTML document**, because an unimplemented method on a file
       * route falls through to `component: () => null`. A client reading that 200 would conclude it had
       * received a profile. Found by `tests/e2e/api/account.spec.ts`.
       *
       * The profile itself is readable at `/api/me/builder` and `/api/me/builders`; this route exists only to
       * edit one, so saying that with a status is more useful than adding a redundant read.
       */
      GET: methodNotAllowed(['PATCH'], 'Read your claimed profiles at /api/me/builders.'),
      DELETE: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })
          const updated = await withTenantContext(principal, (tx) => updateVerifiedBuilderProfile(tx, {
            subjectUserId: principal.userId,
            builderIdentityId: params.builderId,
            topics: parsed.data.claimedTopics,
            openToStatus: parsed.data.openToStatus,
            bio: parsed.data.bio,
          }))
          if (!updated) return Response.json({ error: 'Not your profile' }, { status: 403 })
          return Response.json(updated)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Patch me/builder error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
