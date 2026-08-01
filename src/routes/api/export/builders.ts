import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listOrganizationBuilders, listNotedOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'
import { listItemsForList } from '~/shared/lib/repositories/builder-lists'
import { findVisibleSavedQueryById } from '~/shared/lib/repositories/saved-queries'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'
import { detectSeatOveruse, meterSeatActionAndEmit } from '~/shared/lib/abuse/anomalies'
import { checkExportBurstAndEmit, detectMissingOrImplausibleHeaders, recordExportRequestCadence } from '~/shared/lib/abuse/anti-automation'
import { filterSuppressed } from '~/shared/lib/profile-suppression'
import { env } from '~/shared/lib/env'
import { isExportFormat, isExportScope, MAX_EXPORT_ROWS } from '~/shared/lib/exports/capability-registry'

const QuerySchema = z.object({
  scope: z.string().default('all'),
  format: z.string().default('csv'),
  listId: z.string().optional(),
  savedQueryId: z.string().optional(),
})

/** The one row shape every scope normalizes into before serialization — each source (tenant table
 * join, list item, or a live search result) carries a different native shape; CSV/JSON output must
 * not depend on which. Fields a scope genuinely cannot supply (e.g. score for a shortlist item) are
 * `null`, never fabricated. */
interface ExportRow {
  username: string
  source: string
  displayName: string | null
  profileUrl: string
  score: number | null
  language: string | null
  country: string | null
  topics: string[]
}

function privateString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function privateNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function privateTopics(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export const Route = createFileRoute('/api/export/builders')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const parsed = QuerySchema.safeParse({
            scope: url.searchParams.get('scope') ?? undefined,
            format: url.searchParams.get('format') ?? undefined,
            listId: url.searchParams.get('listId') ?? undefined,
            savedQueryId: url.searchParams.get('savedQueryId') ?? undefined,
          })
          if (!parsed.success) {
            return Response.json({ error: 'Invalid query', issues: parsed.error.flatten() }, { status: 400 })
          }
          const { scope, format, listId, savedQueryId } = parsed.data
          if (!isExportScope(scope)) {
            return Response.json({ error: `Unknown export scope: ${scope}` }, { status: 400 })
          }
          if (!isExportFormat(format)) {
            return Response.json({ error: `Unknown export format: ${format}` }, { status: 400 })
          }
          if (scope === 'list' && !listId) {
            return Response.json({ error: 'listId is required for scope=list' }, { status: 400 })
          }
          if (scope === 'saved-search' && !savedQueryId) {
            return Response.json({ error: 'savedQueryId is required for scope=saved-search' }, { status: 400 })
          }

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

          const { rows, overDailyCap } = await withTenantContext(principal, async (tx) => {
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
            const overDailyCapResult = detectSeatOveruse({ count: usage.count, cap: env.SEAT_DAILY_EXPORTS })

            if (scope === 'all') {
              const builders = await listOrganizationBuilders(tx, principal.organizationId)
              const visible = await filterSuppressed(builders)
              return {
                overDailyCap: overDailyCapResult,
                rows: visible.map((b): ExportRow => ({
                  username: b.username,
                  source: b.source,
                  displayName: b.displayName,
                  profileUrl: b.profileUrl,
                  score: privateNumber((b.privateMetadata as Record<string, unknown>)?.score),
                  language: privateString((b.privateMetadata as Record<string, unknown>)?.language) ?? b.language,
                  country: privateString((b.privateMetadata as Record<string, unknown>)?.country) ?? b.country,
                  topics: privateTopics((b.privateMetadata as Record<string, unknown>)?.topics),
                })),
              }
            }

            if (scope === 'notes') {
              const builders = await listNotedOrganizationBuilders(tx, principal.organizationId)
              const visible = await filterSuppressed(builders)
              return {
                overDailyCap: overDailyCapResult,
                rows: visible.map((b): ExportRow => ({
                  username: b.username,
                  source: b.source,
                  displayName: b.displayName,
                  profileUrl: b.profileUrl,
                  score: privateNumber((b.privateMetadata as Record<string, unknown>)?.score),
                  language: privateString((b.privateMetadata as Record<string, unknown>)?.language) ?? b.language,
                  country: privateString((b.privateMetadata as Record<string, unknown>)?.country) ?? b.country,
                  topics: privateTopics((b.privateMetadata as Record<string, unknown>)?.topics),
                })),
              }
            }

            if (scope === 'list') {
              // Throws SharedResourceError('not_found', ...) for a foreign, private, or nonexistent
              // list — same visibility contract every other shortlist-reading route already uses.
              const items = await listItemsForList(tx, principal, listId!)
              const visible = await filterSuppressed(items)
              return {
                overDailyCap: overDailyCapResult,
                rows: visible.map((item): ExportRow => ({
                  username: item.username,
                  source: item.source,
                  displayName: item.displayName,
                  profileUrl: item.profileUrl,
                  score: null,
                  language: null,
                  country: null,
                  topics: [],
                })),
              }
            }

            // scope === 'saved-search'
            const query = await findVisibleSavedQueryById(tx, principal, savedQueryId!)
            if (!query) {
              throw new SharedResourceError('not_found', 'Saved search not found', 404)
            }
            const { searchBuilders } = await import('~/lib/search')
            const results = await searchBuilders({
              keywords: query.keywords,
              sources: query.sources ?? undefined,
              language: query.language ?? undefined,
              country: query.country ?? undefined,
              page: 1,
              perPage: 100,
            })
            return {
              overDailyCap: overDailyCapResult,
              rows: results.map((r): ExportRow => ({
                username: r.username,
                source: r.source,
                displayName: r.displayName ?? null,
                profileUrl: r.profileUrl,
                score: r.score,
                language: r.language ?? null,
                country: r.country ?? null,
                topics: r.topics,
              })),
            }
          })

          // Real enforcement (as opposed to the metering above, which only ever counts/signals):
          // only blocks once this exact seat has gone over its daily export cap, and only when an
          // operator has deliberately moved ABUSE_ENFORCEMENT_MODE past its `observe` default.
          if (overDailyCap && env.ABUSE_ENFORCEMENT_MODE === 'enforce') {
            return Response.json({ error: 'Daily export limit reached for this seat. Try again tomorrow.' }, { status: 429 })
          }

          const truncated = rows.length > MAX_EXPORT_ROWS
          const bounded = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows

          if (format === 'json') {
            return Response.json(
              { scope, rowCount: bounded.length, truncated, rows: bounded },
              { headers: { 'Content-Disposition': `attachment; filename="builders-${scope}.json"` } },
            )
          }

          const header = ['username', 'source', 'displayName', 'score', 'language', 'country', 'topics', 'profileUrl']
          const csvRows = bounded.map((row) => [
            row.username,
            row.source,
            row.displayName ?? '',
            row.score ?? '',
            row.language ?? '',
            row.country ?? '',
            row.topics.join('; '),
            row.profileUrl,
          ])
          const csv = [
            header.join(','),
            ...csvRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
          ].join('\n')
          return new Response(csv, {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="builders-${scope}.csv"`,
              'X-Export-Row-Count': String(bounded.length),
              'X-Export-Truncated': String(truncated),
            },
          })
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
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
