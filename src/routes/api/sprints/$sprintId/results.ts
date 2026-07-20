import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getTrackedKeySet } from '~/shared/lib/tracked-builders'
import { SOURCE_NAMES } from '~/lib/sources/types'
import { findSprint, listSprintResults } from '~/lib/sprints/service'
import {
  annotateTrackedResults,
  computeLocationFacets,
  filterSprintResults,
  sortSprintResults,
  type SprintResultRow,
} from '~/lib/sprints/results'

const QuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  sort: z.enum(['score', 'date']).default('score'),
  keywords: z.string().optional(),
  sources: z.string().optional(),
  country: z.string().optional(),
  minFollowers: z.coerce.number().int().optional(),
})

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64')
}

export const Route = createFileRoute('/api/sprints/$sprintId/results')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const url = new URL(request.url)
          const rawCursor = url.searchParams.get('cursor')
          const decodedCursor = rawCursor ? Number(Buffer.from(rawCursor, 'base64').toString('utf8')) : 0
          if (rawCursor && (!Number.isInteger(decodedCursor) || decodedCursor < 0)) {
            return Response.json({ error: 'Invalid cursor' }, { status: 400 })
          }

          const parsedQuery = QuerySchema.omit({ cursor: true }).safeParse(Object.fromEntries(url.searchParams))
          if (!parsedQuery.success) {
            return Response.json({ error: 'Invalid query', details: parsedQuery.error.flatten() }, { status: 400 })
          }
          const sourcesFilter = parsedQuery.data.sources
            ?.split(',')
            .map((value) => value.trim())
            .filter((value): value is (typeof SOURCE_NAMES)[number] => (SOURCE_NAMES as readonly string[]).includes(value))
          if (parsedQuery.data.sources && (!sourcesFilter || sourcesFilter.length === 0)) {
            return Response.json({ error: 'Invalid source filter' }, { status: 400 })
          }
          const filter = {
            keywords: parsedQuery.data.keywords?.split(',').map((value) => value.trim()).filter(Boolean) ?? [],
            sources: sourcesFilter,
            country: parsedQuery.data.country,
            minFollowers: parsedQuery.data.minFollowers,
          }

          const { sprint, rows } = await withTenantContext(principal, async (tx) => {
            const sprintRecord = await findSprint(tx, principal.organizationId, params.sprintId)
            if (!sprintRecord) return { sprint: null, rows: [] as SprintResultRow[] }
            const records = await listSprintResults(tx, principal.organizationId, params.sprintId)
            return {
              sprint: sprintRecord,
              rows: records.map((record): SprintResultRow => ({
                id: record.id,
                source: record.source,
                sourceId: record.sourceId,
                profile: record.profile as SprintResultRow['profile'],
                matchedVariant: record.matchedVariant,
                score: record.score,
                createdAt: record.createdAt.toISOString(),
              })),
            }
          })
          if (!sprint) return Response.json({ error: 'Sprint not found' }, { status: 404 })

          const facets = computeLocationFacets(rows.map((row) => row.profile))
          const filtered = sortSprintResults(filterSprintResults(rows, filter), parsedQuery.data.sort)
          const page = filtered.slice(decodedCursor, decodedCursor + parsedQuery.data.limit)
          const nextOffset = decodedCursor + page.length
          const nextCursor = nextOffset < filtered.length ? encodeCursor(nextOffset) : null

          const trackedKeySet = await withTenantContext(principal, (tx) => getTrackedKeySet(tx, principal.organizationId))
          const items = annotateTrackedResults(page, trackedKeySet)

          return Response.json({ items, nextCursor, facets, total: filtered.length })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Sprint results error:', error)
          return Response.json({ error: 'Failed to fetch sprint results' }, { status: 500 })
        }
      },
    },
  },
})
