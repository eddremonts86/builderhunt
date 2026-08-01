import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { findScheduleDefinition } from '~/shared/lib/operational-schedules'
import { setScheduleEnabled } from '~/shared/lib/repositories/platform-operations'

const Body = z.object({ enabled: z.boolean(), expectedVersion: z.number().int().min(1) })

/**
 * Pause/resume a single scheduled job (plans/UI/tasks.md Wave 5 "Add allowlisted pause, resume,
 * and manual-run APIs").
 *
 * `params.jobKey` is never trusted directly — it is only ever used as a lookup key into
 * `OPERATIONAL_SCHEDULES` via `findScheduleDefinition`. An unknown key (typo, path traversal,
 * arbitrary client input) 404s before any database access, so there is no way to toggle a row that
 * isn't a real registered job.
 */
export const Route = createFileRoute('/api/admin/operations/$jobKey')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)

          const definition = findScheduleDefinition(params.jobKey)
          if (!definition) return Response.json({ error: 'Unknown job key' }, { status: 404 })

          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'enabled (boolean) and expectedVersion (integer) are required' }, { status: 400 })

          const result = await setScheduleEnabled(definition.jobKey, parsed.data.enabled, parsed.data.expectedVersion)

          if (result.outcome === 'not_found') {
            return Response.json({ error: 'not_synced', message: 'This job has not been synced into the registry yet.' }, { status: 404 })
          }
          if (result.outcome === 'version_conflict') {
            return Response.json({ error: 'version_conflict', currentVersion: result.currentVersion }, { status: 409 })
          }

          await auditPlatformAdminAction(principal, {
            action: result.enabled ? 'admin.operations.resume' : 'admin.operations.pause',
            targetType: 'operational_schedule',
            targetId: result.jobKey,
            result: 'allowed',
            details: { version: result.version },
          })

          return Response.json({ jobKey: result.jobKey, enabled: result.enabled, version: result.version })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin operations pause/resume error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
