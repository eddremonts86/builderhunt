import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { getUserPreferences, setPrimarySegment } from '~/shared/lib/repositories/user-preferences'
import {
  toUserPreferencesResponse,
  updateUserPreferencesSchema,
} from '~/shared/lib/user-preferences-api'

/**
 * With the flag off the endpoint does not exist, rather than existing and refusing.
 *
 * 404 and not 403: a 403 would tell an unauthenticated prober that this route is real and merely
 * closed, and it would also read as "you lack permission" — which is the one thing this feature
 * never says about anybody. Checked before the session is resolved so a disabled feature costs no
 * database work.
 */
function segmentationDisabledResponse(): Response | null {
  return env.USER_SEGMENTATION_ENABLED === 'true'
    ? null
    : Response.json({ error: 'Not found' }, { status: 404 })
}

/**
 * The authenticated person's own preferences (plan: phase-2/02-segmentacion-usuarios).
 *
 * The subject is `principal.userId` and never anything the body says — see the header of
 * `user-preferences-api.ts` for why the schema refuses to even parse a request that names a user.
 * `withTenantContext` sets `app.user_id`, so the table's row-level security is the second lock: a
 * request that somehow reached this code with the wrong subject would read nothing and write nothing.
 *
 * Nothing here consults or affects authorization. A segment personalises; it grants no access, and
 * this route is reachable by any authenticated member precisely because there is nothing to protect.
 */
export const Route = createFileRoute('/api/me/preferences/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH']),

      GET: async ({ request }) => {
        const disabled = segmentationDisabledResponse()
        if (disabled) return disabled
        try {
          const principal = await requireTenantPrincipal(request)
          const preferences = await withTenantContext(principal, (tx) =>
            getUserPreferences(tx, principal.userId),
          )
          return Response.json(toUserPreferencesResponse(preferences))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Get me/preferences error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      PATCH: async ({ request }) => {
        const disabled = segmentationDisabledResponse()
        if (disabled) return disabled
        try {
          const principal = await requireTenantPrincipal(request)

          // Parsed before anything else touches it, and `.strict()` means an unexpected key is a
          // 400 rather than a value quietly ignored.
          const body: unknown = await request.json().catch(() => null)
          const parsed = updateUserPreferencesSchema.safeParse(body)
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
              { status: 400 },
            )
          }

          const preferences = await withTenantContext(principal, (tx) =>
            setPrimarySegment(tx, {
              subjectUserId: principal.userId,
              segment: parsed.data.primarySegment,
              source: parsed.data.source,
            }),
          )
          return Response.json(toUserPreferencesResponse(preferences))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Patch me/preferences error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
