import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { RECURRENCE_MUTATION_SCOPES } from '~/shared/lib/calendar'
import { httpUrlSchema } from '~/shared/lib/url-safety'
import { cancelEvent, deleteEvent, getEvent, updateEvent } from '~/lib/calendar/service'
import { calendarErrorResponse } from './index'

/** Detail read, versioned scoped update, cancel, and delete for one event. */

const patchSchema = z.object({
  version: z.number().int().positive(),
  recurrenceScope: z.enum(RECURRENCE_MUTATION_SCOPES).optional(),
  recurrenceId: z.string().min(1).max(100).optional(),
  acknowledgeOverlapWarning: z.boolean().default(false),
  // `cancel` is a distinct intent from an ordinary patch: it stops reminders and keeps history.
  cancel: z.boolean().default(false),
  patch: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    location: z.string().max(500).nullable().optional(),
    // `httpUrlSchema` for the same reason as the create route: this value is rendered as an
    // anchor, and `z.string().url()` accepts `javascript:`. Nullable stays — clearing a
    // meeting URL is a legitimate edit.
    meetingUrl: httpUrlSchema.nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    timezone: z.string().min(1).max(64).optional(),
    allDay: z.boolean().optional(),
    busy: z.boolean().optional(),
  }).strict().default({}),
}).strict()

/**
 * The scope fields are not optional decoration: spec.md requires `this|following|series` on
 * DELETE, and `deleteEventRequestSchema` in the API register has always declared them. This
 * schema used to be `.strict()` on `version` alone, so the register documented a capability the
 * route rejected with `invalid_input` — found by the Phase 12 calendar e2e, which asked for a
 * single-occurrence delete and got a 400.
 */
const deleteSchema = z.object({
  version: z.number().int().positive(),
  recurrenceScope: z.enum(RECURRENCE_MUTATION_SCOPES).optional(),
  recurrenceId: z.string().min(1).max(100).optional(),
}).strict()

export const Route = createFileRoute('/api/calendar/events/$eventId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH', 'DELETE']),

      GET: async ({ request, params }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          const principal = await requireTenantPrincipal(request)
          const detail = await withTenantContext(principal, (tx) => getEvent(tx, principal, params.eventId))
          // A caller who may not see the event gets the same 404 as one asking for a
          // non-existent id — the service already collapses both cases.
          if (!detail) return Response.json({ error: 'not_found' }, { status: 404 })
          return Response.json(detail)
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          const principal = await requireTenantPrincipal(request)
          const parsed = patchSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }

          const result = await withTenantContext(principal, (tx) => (parsed.data.cancel
            ? cancelEvent(tx, principal, params.eventId, parsed.data.version).then((event) => ({ event, recurrencePlan: null }))
            : updateEvent(tx, principal, params.eventId, {
                version: parsed.data.version,
                recurrenceScope: parsed.data.recurrenceScope,
                recurrenceId: parsed.data.recurrenceId,
                acknowledgeOverlapWarning: parsed.data.acknowledgeOverlapWarning,
                patch: {
                  ...parsed.data.patch,
                  startsAt: parsed.data.patch.startsAt ? new Date(parsed.data.patch.startsAt) : undefined,
                  endsAt: parsed.data.patch.endsAt ? new Date(parsed.data.patch.endsAt) : undefined,
                },
              })))
          return Response.json(result)
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return Response.json({ error: 'dependency_unavailable' }, { status: 503 })
          const principal = await requireTenantPrincipal(request)
          const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'invalid_input' }, { status: 400 })

          const result = await withTenantContext(principal, (tx) => deleteEvent(tx, principal, params.eventId, {
            version: parsed.data.version,
            recurrenceScope: parsed.data.recurrenceScope,
            recurrenceId: parsed.data.recurrenceId,
          }))
          // The kind is returned because the three outcomes are not interchangeable to a client: a
          // tombstoned event leaves the list, a removed occurrence leaves one cell, and a truncated
          // series keeps every occurrence before the cut.
          return Response.json({ ok: true, ...result })
        } catch (error) {
          return calendarErrorResponse(error)
        }
      },
    },
  },
})
