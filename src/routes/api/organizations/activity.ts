// Plan 29 (activity-feed) task 5 — tenant activity API.
//
// GET /api/organizations/activity?before=<iso>&id=<uuid>&limit=<n>
//
// Keyset-paginated feed of the principal's organization activity.
// The DTO matches the contracts the UI consumes (type, version,
// display, actorUserId nullable for system actions, targetKey,
// metadata, occurredAt).
//
// The route NEVER derives the organization from anything but the
// principal — there is no `?organizationId=` parameter, no header
// to spoof, no fallback. The RLS policy on organization_activity
// is the second line of defense; the principal-scoped repository
// is the first.

import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listActivity } from '~/shared/lib/repositories/activity'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'

const QuerySchema = z.object({
  // Cursor. `before` is the previous page's last row's
  // occurredAt; `id` is the previous page's last row's id.
  // Both are required for a paginated request so the keyset is
  // unambiguous; the first page omits both. A half-supplied
  // cursor is rejected (422) so a buggy client cannot silently
  // paginate into the same page twice.
  before: z.string().datetime().optional(),
  id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  (q) => (q.before === undefined) === (q.id === undefined),
  { message: 'before and id must be supplied together' },
)

export const Route = createFileRoute('/api/organizations/activity')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) {
            return Response.json(
              { error: 'invalid_cursor', issues: parsed.error.issues },
              { status: 422 },
            )
          }
          const before = parsed.data.before && parsed.data.id
            ? { occurredAt: new Date(parsed.data.before), id: parsed.data.id }
            : undefined
          const result = await withTenantContext(principal, (tx) =>
            listActivity(tx, principal, { before, limit: parsed.data.limit }),
          )
          return Response.json({
            rows: result.rows,
            // Serialize the cursor the same way the contracts
            // consume it. The client must pass both `before` and
            // `id` on the next request.
            nextCursor: result.nextCursor
              ? { before: result.nextCursor.occurredAt, id: result.nextCursor.id }
              : null,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          console.error('Activity feed error:', error)
          return Response.json({ error: 'Failed to load activity' }, { status: 500 })
        }
      },
    },
  },
})
