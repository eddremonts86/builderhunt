import { useQuery } from '@tanstack/react-query'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import {
  DEFAULT_DASHBOARD_RANGE,
  parseDashboardOverview,
  type DashboardOverview,
  type DashboardRange,
  type DashboardSections,
} from '~/shared/lib/dashboard/contracts'
import type { WidgetState } from './contracts'

/**
 * Reads `GET /api/dashboard/overview` and translates its wire envelopes into `WidgetState`
 * (plans/ui-dashboard Wave 1, "Refactor the page into core and lazy section queries").
 *
 * ## What the translation is for
 *
 * The wire format and the render format are deliberately not the same type. On the wire a section is
 * `{status, generatedAt, data}` — serializable, versioned, and validated on both sides. In a
 * component it needs `retryable`, which is a function, and `stale`, which is a *judgement* about
 * `generatedAt` that only the client can make because only the client knows how long the value has
 * been sitting in its own cache.
 *
 * Keeping them separate also means the staleness rule lives in one place instead of in each widget's
 * idea of "recent enough".
 *
 * ## Query keys
 *
 * Scoped by organization *and* range, through `organizationQueryKey`, so an organization switch
 * cannot serve the previous tenant's projection while the new one loads. `TenantQueryProvider`
 * clears the whole client on a switch as a second line of defence; the key is the first, and it is
 * what stops a back-navigation re-reading a cached response for an organization the user has left.
 *
 * The response also carries `organizationId`, and `select` refuses a payload whose scope disagrees
 * with the session's active organization. That is not redundant with the key: a slow response for
 * the *previous* organization can still land after the switch, and without the check it would be
 * written into the new organization's cache entry.
 */

/**
 * How old a projection may be before its widgets say so.
 *
 * Twice the server's 30s cache TTL. A value at exactly the TTL is a normal cache hit and captioning
 * it "as of…" would put a freshness warning on every second request; a value at twice it means
 * something is not refreshing.
 */
const STALE_AFTER_MS = 60_000

export interface DashboardOverviewResult {
  /** Set only when the whole response could not be read — a version mismatch or an unparseable body. */
  fatal: 'version' | 'schema' | 'network' | null
  overview: DashboardOverview | null
  isLoading: boolean
  refetch: () => void
  /** Narrows one section into the shape a `WidgetFrame` takes. */
  section: <K extends keyof DashboardSections>(id: K) => WidgetState<SectionData<K>>
}

type SectionEnvelope<K extends keyof DashboardSections> = NonNullable<DashboardSections[K]>
type SectionData<K extends keyof DashboardSections> = Extract<SectionEnvelope<K>, { status: 'ready' }>['data']

export function useDashboardOverview(range: DashboardRange = DEFAULT_DASHBOARD_RANGE): DashboardOverviewResult {
  const organizationId = useActiveOrganizationId()

  const query = useQuery({
    queryKey: organizationQueryKey(organizationId, 'dashboard-overview', range),
    queryFn: async (): Promise<{ ok: true; overview: DashboardOverview } | { ok: false; reason: 'version' | 'schema' | 'network' }> => {
      const response = await fetch(`/api/dashboard/overview?range=${range}`, { credentials: 'include' })
      if (!response.ok) return { ok: false, reason: 'network' }
      const parsed = parseDashboardOverview(await response.json())
      if (!parsed.ok) return parsed
      // A response for a different tenant is discarded rather than rendered. Reached when a switch
      // races a slow request; without this the payload would be cached under the new key.
      if (organizationId && parsed.overview.organizationId !== organizationId) {
        return { ok: false, reason: 'schema' }
      }
      return parsed
    },
    // Never throw: the page must render its shell and its navigation whatever the projection did.
    retry: false,
  })

  const result = query.data
  const overview = result?.ok ? result.overview : null
  const fatal = query.isError ? 'network' : result && !result.ok ? result.reason : null

  return {
    fatal,
    overview,
    isLoading: query.isLoading,
    refetch: () => { void query.refetch() },
    section: <K extends keyof DashboardSections>(id: K): WidgetState<SectionData<K>> => {
      if (query.isLoading) return { kind: 'loading' }
      // A failed or unreadable response is an error for every section, not an empty one for each.
      // This is the whole point of the refactor: the previous page turned a failed fetch into `[]`
      // and each widget rendered its "nothing here yet" copy.
      if (fatal) return { kind: 'error', retryable: true }
      if (!overview) return { kind: 'error', retryable: true }

      const envelope = overview.sections[id] as SectionEnvelope<K> | undefined
      // Absent means the role may not see it. The registry already knows; the frame renders nothing.
      if (!envelope) return { kind: 'forbidden' }

      if (envelope.status === 'unavailable') return { kind: 'unavailable', code: envelope.code }
      if (envelope.status === 'empty') return { kind: 'empty' }

      const age = Date.now() - new Date(envelope.generatedAt).getTime()
      if (age > STALE_AFTER_MS) {
        return {
          kind: 'stale',
          data: envelope.data as SectionData<K>,
          generatedAt: envelope.generatedAt,
          reason: 'cache',
        }
      }
      return { kind: 'ready', data: envelope.data as SectionData<K>, generatedAt: envelope.generatedAt }
    },
  }
}
