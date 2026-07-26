import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { availabilityOverrideInputSchema } from '~/shared/lib/interview-api'
import { addOwnAvailabilityOverride, deleteOwnAvailabilityOverride } from '~/lib/scheduling/availability'
import { availabilityDisabledResponse, availabilityErrorResponse } from './index'

/**
 * Single-date availability overrides (plan:
 * calendar-scheduling-interview-intelligence, Phase 3 "Add availability APIs").
 *
 * Both verbs carry the policy `version` and route through the same versioned write as a full PUT.
 * A bare insert or delete would leave the version untouched, so a client holding the previous
 * version would keep believing its copy was current — every change to the policy has to advance
 * it, not only wholesale replacements.
 */

const addOverrideBodySchema = z.object({
  version: z.number().int().positive(),
  override: availabilityOverrideInputSchema,
}).strict()

const deleteOverrideBodySchema = z.object({
  version: z.number().int().positive(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict()

export const Route = createFileRoute('/api/calendar/availability/overrides')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return availabilityDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = addOverrideBodySchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }
          const saved = await withTenantContext(principal, (tx) => addOwnAvailabilityOverride(tx, principal, parsed.data))
          return Response.json(saved)
        } catch (error) {
          return availabilityErrorResponse(error)
        }
      },
      DELETE: async ({ request }) => {
        try {
          if (env.CALENDAR_ENABLED === 'false') return availabilityDisabledResponse()
          const principal = await requireTenantPrincipal(request)
          const parsed = deleteOverrideBodySchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_input', details: parsed.error.flatten() }, { status: 400 })
          }
          const saved = await withTenantContext(principal, (tx) => deleteOwnAvailabilityOverride(tx, principal, parsed.data))
          return Response.json(saved)
        } catch (error) {
          return availabilityErrorResponse(error)
        }
      },
    },
  },
})
