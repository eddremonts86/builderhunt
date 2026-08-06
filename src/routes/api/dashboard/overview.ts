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
  getDashboardAlertVolume,
  getDashboardDiscoveryTrend,
  getDashboardRecency,
  getDashboardSourceCoverage,
  getDashboardSummary,
} from '~/shared/lib/repositories/dashboard-overview'
import {
  DASHBOARD_ROW_LIMITS,
  DASHBOARD_SCHEMA_VERSION,
  DEFAULT_DASHBOARD_RANGE,
  dashboardOverviewSchema,
  dashboardRangeSchema,
  PROFILE_VIEW_COHORT_FLOOR,
  type DashboardOverview,
  type DashboardUsage,
} from '~/shared/lib/dashboard/contracts'
import { buildActionQueue } from '~/shared/lib/dashboard/action-rules'
import { getOnboardingStatus } from '~/shared/lib/onboarding'
import { listOrganizationTriggers } from '~/shared/lib/repositories/organization-alerts'
import { listSprints } from '~/lib/sprints/service'
import { listUpcomingAppointments } from '~/shared/lib/repositories/dashboard-upcoming'
import { listReviewCandidates, listShortlistSummaries } from '~/shared/lib/repositories/dashboard-review'
import { getInvitationDistribution } from '~/shared/lib/repositories/dashboard-invitations'
import { listActivity } from '~/shared/lib/repositories/activity'
import { getVerifiedProfileOwnerSummary } from '~/shared/lib/repositories/builder-profile-views'
import { resolveActorDisplayNames } from '~/shared/lib/auth/organization-lifecycle'
import { listInvitationsForEmail } from '~/shared/lib/organizations/contracts'
import { auth } from '~/shared/lib/auth/better-auth'

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
 * ## The key is per **user**, and that is a correction
 *
 * The plan specifies "organization, role class, range, and schema version", and that was right while
 * every section was an organization aggregate. The action queue is not: `getOnboardingStatus` is
 * keyed by `(organizationId, userId)`, and pending membership invitations are addressed to a person
 * and can point at an organization this one has nothing to do with.
 *
 * Under an organization-scoped key, the first teammate to load the dashboard would have written
 * *their* onboarding progress and *their* invitations into an entry the next teammate reads. That is
 * a cross-user disclosure inside a correctly isolated tenant — the same shape as the two-rows-per-key
 * mistake that once wrote a preview database URL over production, and as `search.ts` serving a
 * timed-out source's empty result as a success. A cache indexed by too little.
 *
 * The cost is a cache multiplied by team size at a 30-second TTL, which is nothing. The role class
 * stays in the key anyway: it is what stops an owner's `usage` reaching a member if the two ever
 * shared an entry.
 */
const CACHE_TTL_SECONDS = 30

/**
 * The window the owner tile reports over.
 *
 * Thirty days, matching `GET /api/builders/$builderId/views` — the tile is a glance at the same
 * number `/me` shows in detail, and two different windows would make them look like they disagree.
 */
const PROFILE_VIEW_WINDOW_DAYS = 30

type RoleClass = 'billing-reader' | 'member'

export function cacheKey(organizationId: string, userId: string, roleClass: RoleClass, range: string): string {
  /*
   * Segments are percent-encoded, not interpolated raw.
   *
   * The key is colon-delimited, so raw interpolation makes `('org-1:user-9', 'user-1')` and
   * `('org-1', 'user-9:user-1')` produce the *same string* — two different callers reading one
   * entry. Ids here come from the session rather than from a request, so this is defence in depth
   * rather than a live hole; it is fixed because "not reachable today" is a property of the current
   * call sites, and a delimiter ambiguity is a property of the function. Encoding removes the
   * ambiguity at the only place that can.
   */
  const segment = (value: string) => encodeURIComponent(value)
  return [
    'dashboard:overview',
    `v${DASHBOARD_SCHEMA_VERSION}`,
    segment(organizationId),
    segment(userId),
    roleClass,
    range,
  ].join(':')
}

/**
 * Whether a stored meeting link is something a browser may be sent to.
 *
 * `meeting_url` is user-typed. The contract already refuses anything that is not absolute http(s),
 * so this exists to fail *one row* rather than the response: without it a single malformed link
 * would fail outbound validation and 500 the whole dashboard for that user.
 */
function isSafeMeetingUrl(value: string | null): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
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
          const key = cacheKey(principal.organizationId, principal.userId, roleClass, range)

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

          const [summary, recency, sourceCoverage, discoveryTrend, alertVolume] = await withTenantContext(principal, async (transaction) => Promise.all([
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
            section('discoveryTrend', generatedAt,
              () => getDashboardDiscoveryTrend(transaction, principal.organizationId, now, range),
              (value) => value.buckets.every((bucket) => bucket.count === 0)),
            section('alertVolume', generatedAt,
              () => getDashboardAlertVolume(transaction, principal.organizationId, now, range),
              (value) => value.buckets.every((bucket) => bucket.count === 0)),
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

          /*
           * The agenda. Its own section rather than part of the summary because it fails on its own
           * terms: the calendar tables are a different subsystem, and a broken join there must not
           * take the headline counts with it.
           *
           * Owner-scoped by `principal.userId`, not by organization. Calendar events are personal
           * even inside a shared tenant, and a dashboard is not where someone discovers a
           * colleague's schedule.
           */
          const upcoming = await section('upcoming', generatedAt, async () => {
            const items = await withTenantContext(principal, (transaction) =>
              listUpcomingAppointments(
                transaction,
                principal.organizationId,
                principal.userId,
                now,
                DASHBOARD_ROW_LIMITS.upcoming,
              ))
            return {
              items: items.map((item) => ({
                eventId: item.eventId,
                title: item.title,
                startsAt: item.startsAt.toISOString(),
                endsAt: item.endsAt.toISOString(),
                timezone: item.timezone,
                allDay: item.allDay,
                type: item.type,
                location: item.location,
                /*
                 * Dropped rather than passed through when it is not an absolute http(s) URL. The
                 * contract refuses anything else, so leaving a `javascript:` value here would fail
                 * the outbound validation and take the *whole response* down with a 500 — one user's
                 * malformed meeting link breaking every other section of their dashboard. A null
                 * meeting link degrades one row.
                 */
                meetingUrl: isSafeMeetingUrl(item.meetingUrl) ? item.meetingUrl : null,
                hasActiveBrief: item.hasActiveBrief,
                invitationId: item.invitationId,
              })),
            }
          }, (value) => value.items.length === 0)

          /*
           * Candidates to review. Its own section for the same reason as the agenda: it reads a
           * different subsystem, and a broken join in alerts or sprints must not take the counts
           * with it.
           *
           * Deliberately does *not* include live recommendations — `GET /api/recommendations`
           * re-runs the saved queries through the federated search pipeline, and folding that into a
           * projection read on every dashboard load would put thirteen connectors behind every page
           * view. See the note in `dashboard-review.ts`.
           */
          const review = await section('review', generatedAt, async () => {
            const items = await withTenantContext(principal, (transaction) =>
              listReviewCandidates(transaction, principal.organizationId, DASHBOARD_ROW_LIMITS.review))
            return {
              items: items.map((item) => ({
                key: item.key,
                source: item.source,
                username: item.username,
                displayName: item.displayName,
                provenance: item.provenance,
                reason: item.reason,
                score: item.score,
                tracked: item.tracked,
                organizationBuilderId: item.organizationBuilderId,
              })),
            }
          }, (value) => value.items.length === 0)

          /*
           * The action queue reads a snapshot the route assembles, and the rules are a pure function
           * of it (`action-rules.ts`). Assembled *after* the sections above so `usage` can be fed in
           * only when the role produced one — a member's snapshot has `usage: null`, so the usage
           * rules cannot fire for them structurally rather than by checking a role a second time.
           *
           * Every input is bounded and already redacted: ids, counts, statuses and timestamps. No
           * note text, candidate email, transcript or provider metadata is fetched at all, so no
           * rule can leak one.
           */
          const actionQueue = await section('actionQueue', generatedAt, async () => {
            const snapshot = await withTenantContext(principal, async (transaction) => {
              const [onboarding, triggers, sprints] = await Promise.all([
                getOnboardingStatus(transaction, principal.organizationId, principal.userId),
                listOrganizationTriggers(transaction, principal.organizationId, DASHBOARD_ROW_LIMITS.alerts),
                listSprints(transaction, principal.organizationId),
              ])
              return { onboarding, triggers, sprints }
            })

            /*
             * Invitations are addressed to a *person*, not to the active tenant, so they come from
             * the auth store and are keyed by the caller's own session email — never a value from
             * the request, or any authenticated user could enumerate who has been invited where.
             * `TenantPrincipal` deliberately carries no email, which is why the session is read
             * again here rather than threaded through.
             *
             * An unverified email yields nothing, matching `/api/organizations/invitations/mine`:
             * acceptance already requires a verified matching address, so telling an unverified
             * account that an invitation is waiting leaks something it cannot act on.
             */
            const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
            const invitations = session?.user?.emailVerified && session.user.email
              ? await listInvitationsForEmail(session.user.email).catch(() => [])
              : []

            return {
              items: buildActionQueue({
                now,
                onboarding: { complete: snapshot.onboarding.completed || snapshot.onboarding.skipped },
                membershipInvitations: invitations
                  .filter((invitation) => invitation.status === 'pending')
                  .map((invitation) => ({ id: invitation.id })),
                unreadAlerts: snapshot.triggers
                  .filter((trigger) => trigger.readAt === null)
                  .map((trigger) => ({
                    id: trigger.id,
                    // Every unread trigger is high value today: the product only writes one when an
                    // alert's criteria matched. A cheaper class of trigger would set this false.
                    highValue: true,
                    triggeredAt: new Date(trigger.matchedAt),
                  })),
                sprints: snapshot.sprints.map((sprint) => ({
                  id: sprint.id,
                  name: sprint.name,
                  status: sprint.status,
                  resultCount: sprint.resultCount,
                  lastRunAt: sprint.lastRunAt,
                })),
                // The agenda the section above already computed, reused rather than re-queried:
                // two reads of the same window a few milliseconds apart can disagree about an
                // interview starting right now, and the queue and the agenda must not.
                upcoming: upcoming.status === 'ready'
                  ? upcoming.data.items.map((item) => ({
                      eventId: item.eventId,
                      title: item.title,
                      startsAt: new Date(item.startsAt),
                      type: item.type,
                      hasActiveBrief: item.hasActiveBrief,
                    }))
                  : [],
                usage: usage.status === 'ready'
                  ? {
                      seatsUsed: usage.data.seats?.used ?? 0,
                      seatsAllowed: usage.data.seats?.allowed ?? 0,
                      creditBalanceUnits: usage.data.creditBalanceUnits ?? 0,
                      paidActionsAllowed: usage.data.paidActionsAllowed,
                    }
                  : null,
              }).items,
            }
          }, (value) => value.items.length === 0)

          /*
           * Shortlists the caller may see: their own, plus anything shared with the organization.
           * Scoped by `principal.userId` as well as the tenant, because a colleague's *private*
           * shortlist is a list of people they are considering and does not belong on someone else's
           * dashboard.
           */
          const shortlists = await section('shortlists', generatedAt, async () => {
            const items = await withTenantContext(principal, (transaction) =>
              listShortlistSummaries(
                transaction,
                principal.organizationId,
                principal.userId,
                DASHBOARD_ROW_LIMITS.shortlists,
              ))
            return {
              items: items.map((item) => ({
                id: item.id,
                name: item.name,
                visibility: item.visibility === 'organization' ? 'organization' as const : 'private' as const,
                itemCount: item.itemCount,
                updatedAt: item.updatedAt.toISOString(),
              })),
            }
          }, (value) => value.items.length === 0)

          /*
           * Invitations the caller sent. Owner-scoped by `principal.userId`, not by organization: an
           * invitation names a candidate a specific person is interviewing, and a colleague's belong
           * on a colleague's dashboard.
           */
          const invitations = await section('invitations', generatedAt, async () => {
            return withTenantContext(principal, (transaction) =>
              getInvitationDistribution(transaction, principal.organizationId, principal.userId))
          }, (value) => value.total === 0)

          /*
           * Recent team activity, bounded to five. Not paginated and not counted: the plan is
           * explicit that event volume must not be framed as employee performance, and the cheapest
           * way to honour that is to send nothing anyone could chart. The full log is `/team/activity`.
           *
           * `listActivity` already formats each line and resolves its target link against the real
           * row, so a deleted target arrives as plain text rather than as a link to a 404. The actor
           * name is resolved separately because `auth_users` is auth-broker-owned and the tenant
           * repository has no grant on it — the same two-step the activity route does.
           */
          const activity = await section('activity', generatedAt, async () => {
            const result = await withTenantContext(principal, (transaction) =>
              listActivity(transaction, principal, { limit: DASHBOARD_ROW_LIMITS.activity }))
            const actorIds = result.rows
              .map((row) => row.actorUserId)
              .filter((id): id is string => id !== null)
            const namesByUserId = await resolveActorDisplayNames(principal.organizationId, actorIds)
            return {
              items: result.rows.map((row) => ({
                id: row.id,
                display: row.display,
                // `null` means "unknown or no longer a member", which the UI renders as
                // *Former member* — never a blank and never a raw user id.
                actorDisplayName: row.actorUserId ? namesByUserId.get(row.actorUserId) ?? null : null,
                occurredAt: row.occurredAt,
                targetHref: row.targetHref,
              })),
            }
          }, (value) => value.items.length === 0)

          /*
           * The verified-profile-owner summary (plans/ui-dashboard Wave 5).
           *
           * Included only when the repository found a verified claim; for anybody else the key is
           * absent entirely, exactly like `usage` for a non-billing role.
           *
           * Not built with `section()`, which is the point worth reading. That helper's three outcomes
           * are ready / empty / unavailable, and this section needs a fourth it cannot express:
           * *absent*. `empty` would tell someone who owns no profile that they own one with nothing to
           * show, and `unavailable` would tell them their summary failed. Both answer a question that
           * was never asked of this account.
           *
           * Scoped by user, not by organization. `builder_claims` RLS keys on `app.user_id` alone
           * because a claim is a fact about a person, so the same tile appears in every workspace they
           * belong to — right, and worth saying out loud because every other section here is tenant
           * data that must not.
           */
          const profileOwner = await (async () => {
            try {
              const from = new Date(now.getTime() - PROFILE_VIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000)
              const summary = await withTenantContext(principal, (transaction) =>
                getVerifiedProfileOwnerSummary(
                  transaction,
                  principal.userId,
                  from,
                  now,
                  PROFILE_VIEW_COHORT_FLOOR,
                ))
              if (!summary) return null
              return {
                status: 'ready' as const,
                generatedAt,
                data: { ...summary, windowDays: PROFILE_VIEW_WINDOW_DAYS },
              }
            } catch (error) {
              // Logged like any other section, but still omitted rather than reported as unavailable:
              // a failure message would tell a non-owner that something applies to them.
              metrics.increment('dashboardOverviewSectionFailures')
              log.error('dashboard_overview_section_failed', {
                section: 'profileOwner',
                error: error instanceof Error ? error.message : 'unknown',
              })
              return null
            }
          })()

          const payload: DashboardOverview = {
            schemaVersion: DASHBOARD_SCHEMA_VERSION,
            organizationId: principal.organizationId,
            range,
            generatedAt,
            sections: {
              summary,
              recency,
              actionQueue,
              sourceCoverage,
              upcoming,
              review,
              shortlists,
              invitations,
              activity,
              discoveryTrend,
              alertVolume,
              ...(roleClass === 'billing-reader' ? { usage } : {}),
              ...(profileOwner ? { profileOwner } : {}),
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
