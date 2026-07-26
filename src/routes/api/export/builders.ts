import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'
import { detectSeatOveruse, meterSeatActionAndEmit } from '~/shared/lib/abuse/anomalies'
import { checkExportBurstAndEmit, detectMissingOrImplausibleHeaders, recordExportRequestCadence } from '~/shared/lib/abuse/anti-automation'
import { filterSuppressed } from '~/shared/lib/profile-suppression'
import { env } from '~/shared/lib/env'

export const Route = createFileRoute('/api/export/builders')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          // Automation heuristics (Phase 4 "Export burst throttle + proportionate
          // anti-automation") — independent of the day cap below, never blocks on its own.
          const suspiciousHeaders = detectMissingOrImplausibleHeaders({
            userAgent: request.headers.get('user-agent'),
            accept: request.headers.get('accept'),
          })
          const nonInteractiveCadence = recordExportRequestCadence(`${principal.organizationId}:${principal.userId}`)
          await checkExportBurstAndEmit(
            { suspiciousHeaders, nonInteractiveCadence },
            { userId: principal.userId, organizationId: principal.organizationId, requestId: principal.requestId },
          )

          const { builders, overDailyCap } = await withTenantContext(principal, async (tx) => {
            // Meter (Phase 4 "core actions per seat") — one 'exports' unit per export event
            // (matches SEAT_DAILY_EXPORTS' per-event framing, not per-row); the increment+signal
            // itself is always observe-only (meterSeatActionAndEmit never blocks).
            const usage = await meterSeatActionAndEmit(tx, {
              organizationId: principal.organizationId,
              userId: principal.userId,
              action: 'exports',
              cap: env.SEAT_DAILY_EXPORTS,
              requestId: principal.requestId,
            })
            return {
              builders: await listOrganizationBuilders(tx, principal.organizationId),
              overDailyCap: detectSeatOveruse({ count: usage.count, cap: env.SEAT_DAILY_EXPORTS }),
            }
          })

          // Real enforcement (as opposed to the metering above, which only ever counts/signals):
          // only blocks once this exact seat has gone over its daily export cap, and only when an
          // operator has deliberately moved ABUSE_ENFORCEMENT_MODE past its `observe` default.
          if (overDailyCap && env.ABUSE_ENFORCEMENT_MODE === 'enforce') {
            return Response.json({ error: 'Daily export limit reached for this seat. Try again tomorrow.' }, { status: 429 })
          }

          const visibleBuilders = await filterSuppressed(builders)
          const header = ['username', 'source', 'score', 'language', 'country', 'topics', 'profileUrl']
          const rows = visibleBuilders.map((builder) => [
            builder.username,
            builder.source,
            typeof builder.privateMetadata.score === 'number' ? builder.privateMetadata.score : 0,
            privateString(builder.privateMetadata.language) ?? builder.language ?? '',
            privateString(builder.privateMetadata.country) ?? builder.country ?? '',
            privateTopics(builder.privateMetadata).join('; '),
            builder.profileUrl,
          ])
          const csv = [
            header.join(','),
            ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
          ].join('\n')
          return new Response(csv, {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': 'attachment; filename="builders.csv"',
            },
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Export error:', error)
          return Response.json({ error: 'Export failed' }, { status: 500 })
        }
      },
    },
  },
})

function privateString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function privateTopics(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.topics)
    ? metadata.topics.filter((value): value is string => typeof value === 'string')
    : []
}
