import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { log } from '~/shared/lib/log'
import { metrics } from '~/shared/lib/metrics'
import { canReadBillingSummary } from '~/shared/lib/billing/permissions'
// Only the elevated read is imported. `getBillingAvailability` is the member-facing shape and is
// deliberately not used here: a member's payload omits `usage` entirely rather than carrying a
// reduced version of it.
import { getOrganizationBillingSummary } from '~/shared/lib/billing/contracts'
import {
  getDashboardRecency,
  getDashboardSourceCoverage,
  getDashboardSummary,
} from '~/shared/lib/repositories/dashboard-overview'
import {
  DASHBOARD_SCHEMA_VERSION,
  DEFAULT_DASHBOARD_RANGE,
  dashboardOverviewSchema,
  dashboardRangeSchema,
  type DashboardOverview,
  type DashboardUsage,
} from '~/shared/lib/dashboard/contracts'

/**
 * The one core dashboard read (plans/ui-dashboard Wave 1, "Implement `GET /api/dashboard/overview`").
 *
 * ## What it replaces
 *
 * Seven parallel fetches from `DashboardPage`, four of them ending in `.catch(() => [])`. That
 * pattern is the reason the spec's second structural problem is "failures look empty": a caught
 * error became an empty array, and every widget renders an empty array as "nothing here yet". A user
 * could not distinguish a quiet workspace from a broken one, and neither could an operator, because
 * nothing was counted.
 *
 * ## Independent sections, and what that costs
 *
 * Every section is computed in its own `try`, so one failing aggregate produces
 * `{status: 'unavailable'}` for that section and a 200 for the page. The alternative — failing the
 * whole response — turns a broken source-coverage query into a dashboard nobody can use, including
 * the parts that would have told them what to do next.
 *
 * The cost is that a section can be dead for every tenant while the endpoint looks healthy, which is
 * the identical shape of the bug this project keeps finding. `dashboardOverviewSectionFailures` is
 * the counter that makes it visible; there is no other trace.
 *
 * ## Role minimization happens here
 *
 * `usage` is **absent** from the payload for a role that may not read billing — not present and
 * empty, not `null`. The client's widget registry already knows the role is ineligible, so nothing
 * needs the key to exist, and sending `{status: 'forbidden'}` would confirm to a member that the
 * workspace has billing at all.
 *
 * ## Validation on the way out
 *
 * The response is parsed against its own schema before it is sent. That looks redundant and is not:
 * the row caps and the id pattern in `contracts.ts` are the guarantee that no repository can ever
 * emit an unbounded list or a resource id shaped like a path, and a guarantee only checked by the
 * client is a guarantee the client can be talked out of.
 */

/**
 * Bounded, and short. The projection is cheap and mostly counts; a long TTL would trade a few
 * milliseconds for a dashboard that disagrees with the page a user just navigated from.
 *
 * The key carries the organization, the **role class**, the range and the schema version. Role class
 * rather than user id: two owners see the same projection, and keying by user would multiply the
 * cache by the size of the team for no difference in content. Omitting the role would be the actual
 * hazard — a member's cached response served to an owner would silently drop `usage`, and an owner's
 * served to a member would disclose it.
 */
const CACHE_TTL_SECONDS = 30

type RoleClass = 'billing-reader' | 'member'

function cacheKey(organizationId: string, roleClass: RoleClass, range: string): string {
  return `dashboard:overview:v${DASHBOARD_SCHEMA_VERSION}:${organizationId}:${roleClass}:${range}`
}

/**
 * Runs one section and converts any failure into an envelope rather than a rejection.
 *
 * The error is logged with the section name and nothing else from the payload: these aggregates read
 * candidate rows, and a stack trace or a driver message can carry column values.
 */
async function section<T>(
  name: string,
  generatedAt: string,
  compute: () => Promise<T>,
  isEmpty: (value: T) => boolean,
): Promise<{ status: 'ready'; generatedAt: string; data: T } | { status: 'empty'; generatedAt: string } | { status: 'unavailable'; code: 'section_failed' }> {
  try {
    const data = await compute()
    if (isEmpty(data)) return { status: 'empty', generatedAt }
    return { status: 'ready', generatedAt, data }
  } catch (error) {
    metrics.increment('dashboardOverviewSectionFailures')
    log.error('dashboard_overview_section_failed', {
      section: name,
      error: error instanceof Error ? error.message : 'unknown',
    })
    return { status: 'unavailable', code: 'section_failed' }
  }
}

export const Route = createFileRoute('/api/dashboard/overview')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        const started = Date.now()
        try {
          const principal = await requireTenantPrincipal(request)

          // An unknown range is a 400, not a silent fallback: a window the caller did not ask for
          // produces numbers they will read as the answer to the question they did ask.
          const requested = new URL(request.url).searchParams.get('range')
          const parsedRange = requested === null
            ? { success: true as const, data: DEFAULT_DASHBOARD_RANGE }
            : dashboardRangeSchema.safeParse(requested)
          if (!parsedRange.success) {
            return Response.json({ error: 'Unsupported range' }, { status: 400 })
          }
          const range = parsedRange.data

          const roleClass: RoleClass = canReadBillingSummary(principal) ? 'billing-reader' : 'member'
          const key = cacheKey(principal.organizationId, roleClass, range)

          const redis = await import('~/shared/lib/redis').then((module) => module.getRedis()).catch(() => null)
          if (redis) {
            const cached = await redis.get(key).catch(() => null)
            if (cached) {
              const parsed = dashboardOverviewSchema.safeParse(JSON.parse(cached))
              // A cache entry that no longer parses is discarded rather than served. The key carries
              // the schema version, so this only happens for a hand-written or corrupted value.
              if (parsed.success && parsed.data.organizationId === principal.organizationId) {
                metrics.increment('dashboardOverviewCacheHits')
                log.info('dashboard_overview', { range, cache: 'hit', durationMs: Date.now() - started })
                return Response.json(parsed.data)
              }
            }
          }
          metrics.increment('dashboardOverviewCacheMisses')

          // One clock for the whole response. Four aggregates each reading their own `new Date()`
          // can report a builder inside one window and outside another, under load only.
          const now = new Date()
          const generatedAt = now.toISOString()

          const [summary, recency, sourceCoverage] = await withTenantContext(principal, async (transaction) => Promise.all([
            section('summary', generatedAt,
              () => getDashboardSummary(transaction, principal.organizationId, now, range),
              // A workspace with nothing tracked and nothing saved has an empty summary, not a zeroed
              // one: the widget's job there is the first-hunt call to action.
              (value) => value.trackedBuilders === 0 && value.savedSearches === 0),
            section('recency', generatedAt,
              () => getDashboardRecency(transaction, principal.organizationId, now, range),
              (value) => value.buckets.every((bucket) => bucket.count === 0)),
            section('sourceCoverage', generatedAt,
              () => getDashboardSourceCoverage(transaction, principal.organizationId),
              (value) => value.sources.length === 0),
          ]))

          const usage = await section<DashboardUsage>('usage', generatedAt, async () => {
            if (roleClass !== 'billing-reader') {
              // Unreachable — the key is omitted below for a member. Kept as a second refusal so a
              // future edit that always builds the section cannot leak it by forgetting the `if`.
              throw new Error('usage requires billing:read')
            }
            const billing = await getOrganizationBillingSummary(principal)
            // `limit` upstream, `allowed` here: the contract's word for the same number, chosen
            // because "limit" reads as a ceiling being enforced and this is a seat allowance.
            const seatsAllowed = billing.seats.limit
            const seatsUsed = billing.seats.used
            const overSeats = seatsAllowed > 0 && seatsUsed >= seatsAllowed
            const noCredits = billing.creditBalanceUnits <= 0
            return {
              tier: billing.tier,
              paidActionsAllowed: billing.capabilities.paidActionsAllowed,
              seats: { used: seatsUsed, allowed: seatsAllowed },
              creditBalanceUnits: billing.creditBalanceUnits,
              // Evaluated here, once, rather than by each client re-deriving a threshold. Two
              // implementations of "are we near the limit" is two answers.
              warning: overSeats
                ? { severity: 'warning' as const, message: `All ${seatsAllowed} seats are in use.` }
                : noCredits
                  ? { severity: 'warning' as const, message: 'No credits remaining for paid actions.' }
                  : null,
            }
          }, () => false)

          const payload: DashboardOverview = {
            schemaVersion: DASHBOARD_SCHEMA_VERSION,
            organizationId: principal.organizationId,
            range,
            generatedAt,
            sections: {
              summary,
              recency,
              actionQueue: { status: 'empty', generatedAt },
              sourceCoverage,
              ...(roleClass === 'billing-reader' ? { usage } : {}),
            },
          }

          // Validated on the way out. The caps and id pattern in `contracts.ts` are only a guarantee
          // if the producer is held to them too.
          const validated = dashboardOverviewSchema.safeParse(payload)
          if (!validated.success) {
            log.error('dashboard_overview_contract_violation', {
              issues: validated.error.issues.map((issue) => issue.path.join('.')),
            })
            return Response.json({ error: 'Failed to build overview' }, { status: 500 })
          }

          if (redis) {
            await redis.set(key, JSON.stringify(validated.data), 'EX', CACHE_TTL_SECONDS).catch(() => null)
          }

          log.info('dashboard_overview', {
            range,
            cache: 'miss',
            durationMs: Date.now() - started,
            // Section states, never their contents. An operator needs to know `sourceCoverage` is
            // failing; nobody needs the rows to find that out.
            sections: Object.entries(validated.data.sections)
              .map(([name, envelope]) => `${name}:${envelope?.status ?? 'omitted'}`),
          })

          return Response.json(validated.data)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          log.error('dashboard_overview_failed', { error: error instanceof Error ? error.message : 'unknown' })
          return Response.json({ error: 'Failed to load overview' }, { status: 500 })
        }
      },
    },
  },
})
