import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { httpStatusForApiErrorCode, type ApiErrorCode } from '~/shared/lib/api-errors'
import { putAvailabilityRequestSchema } from '~/shared/lib/interview-api'
import { getOwnAvailability, putOwnAvailability } from '~/lib/scheduling/availability'
import { ensureDefaultCalendar } from '~/shared/lib/repositories/calendar'

/**
 * The caller's own weekly availability policy (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Add availability APIs").
 *
 * PUT replaces the whole policy under an optimistic version. Availability only makes sense as a
 * set — overlaps and rule/override interaction are cross-row properties — so per-rule CRUD would
 * let a client assemble a combination that no single request ever validated.
 */

/** Shared by both availability routes; keeps the error vocabulary identical across them. */
export function availabilityErrorResponse(error: unknown) {
  if (error instanceof TenantAuthorizationError) {
    return Response.json({ error: 'authentication_required' }, { status: 401 })
  }
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : null
  if (code === 'state_changed') {
    return Response.json({ error: 'state_changed' }, { status: 409 })
  }
  if (code === 'invalid_input' || code === 'forbidden') {
    // The message is safe to return: it is authored here and names only the caller's own input.
    return Response.json(
      { error: code, message: error instanceof Error ? error.message : undefined },
      { status: httpStatusForApiErrorCode(code as ApiErrorCode) },
    )
  }
  console.error('calendar availability route error:', error)
  return Response.json({ error: 'invalid_input' }, { status: 400 })
}

export function availabilityDisabledResponse() {
  return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
}

export const Route = createFileRoute('/api/calendar/availability/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return availabilityDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const policy = await withTenantContext(principal, (tx) => getOwnAvailability(tx, principal))
          return Response.json(policy)
        } catch (error) {
          return availabilityErrorResponse(error)
        }
      },
      PUT: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return availabilityDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = putAvailabilityRequestSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }
          const saved = await withTenantContext(principal, async (tx) => {
            // Publishing availability is the other way an organizer says time can be booked with
            // them, and a booking needs a calendar to land in. See `ensureDefaultCalendar` — the
            // candidate flow used to fail with `invalid_input` when neither path had run.
            const timezone = parsed.data.rules[0]?.timeZone
            if (timezone) {
              await ensureDefaultCalendar(tx, {
                organizationId: principal.organizationId,
                ownerUserId: principal.userId,
                timezone,
              })
            }
            return putOwnAvailability(tx, principal, parsed.data)
          })
          return Response.json(saved)
        } catch (error) {
          return availabilityErrorResponse(error)
        }
      },
    },
  },
})
