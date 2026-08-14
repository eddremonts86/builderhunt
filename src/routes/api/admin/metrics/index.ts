import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { interviewOperatorCounters, metrics } from '~/shared/lib/metrics'
import { getOnboardingActivationMetrics, getPlatformAccountMetrics } from '~/shared/lib/repositories/platform-billing'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'
import { env } from '~/shared/lib/env'
import { getRemovalRequestMetrics } from '~/shared/lib/repositories/profile-removal'
import { countUsersBySegment } from '~/shared/lib/repositories/user-preferences'
import { publicDb } from '~/shared/lib/db/client'

/**
 * The bounded legacy compatibility response for `/admin/metrics` (plan 57, Admin track — "Split the
 * monolithic Admin Metrics API").
 *
 * ## This endpoint is legacy, and these are its three remaining consumers
 *
 * The page no longer reads it on a timer, and no longer reads it at all to render numbers. The eight sections
 * come from `sections.ts` and `overview.ts`, which return a versioned contract. What still comes from here is
 * exactly three things, each on the one tab that needs it:
 *
 * - `interviews.capabilities` — the Reliability tab's per-flag grid.
 * - `discovery` — the Discovery tab's current-run state disclosure.
 * - `server` — the Runtime tab's process diagnostics, fetched only when that disclosure is opened.
 *
 * ## What has to be true before it can be deleted
 *
 * All three are facts the section contract cannot currently carry: `metricValueSchema` accepts a finite
 * `number` and nothing else, and these are booleans and strings. Two ways out, and neither is free:
 *
 * - The capability flags could collapse into `unavailable: 'not_enabled'`, which is what that code is for —
 *   but that loses *which* door is shut, and the flags are reported individually precisely because they fail
 *   independently. Transcription can be off while scheduling is on, and an operator reading
 *   `transcriptReconnects: 0` needs to know which of those two it is.
 * - The contract could grow a non-numeric field, which is a schema-version bump for a capability grid, a
 *   worker cursor and a Node version.
 *
 * Until one of those is decided, this stays. What is *not* acceptable is it growing: the response is a fixed
 * set of keys over scalars and small aggregates, with no collection whose length is decided by how much data
 * exists. `tests/e2e/api/admin.spec.ts` asserts that key set, so adding one here fails a gate rather than
 * quietly re-monolithing the endpoint.
 *
 * ## `?fields=` — the payload was bounded, the *work* was not
 *
 * The response shape has been a fixed key set since the split. What every request still did was compute all of
 * it: two platform DB aggregates, a discovery-state read, and a removal-metrics read when that feature is on.
 * Set against what the three callers actually read, that was almost entirely waste —
 *
 * - `server` is `process.version`, `process.platform`, `process.pid` and `process.memoryUsage()`. **No database
 *   at all.** Opening the Runtime tab's diagnostics disclosure ran two platform aggregates and a discovery read
 *   to answer a question about the current process.
 * - `interviews` is five environment flags plus counters already held in memory. Also no database.
 * - `discovery` needs `getDiscoveryState` and nothing else.
 *
 * So a caller names the fields it reads and the route computes only those. `fields` is an allowlist over a closed
 * vocabulary and an unknown name is a **400**, matching what `sections.ts` does with an unknown section: silently
 * dropping it would answer 200 with a key the caller is waiting for and never told was refused.
 *
 * Omitting `fields` still returns everything, and that is the compatibility half of a legacy compatibility
 * endpoint — an external caller, and the e2e gate that pins the full key set, keep working unchanged.
 *
 * ## What it deliberately does not return, and still will not
 *
 * It used to include a `billing` block from `getBillingOperationsMetrics`, which walks **every
 * organization serially** — one transaction and nine queries each, plus one more per active credit
 * grant — and reads the whole `billing_webhook_events` table twice to count statuses in JS. The page
 * never referenced the field. With a 15-second refresh, that was the full cross-organization scan
 * roughly 240 times an hour to populate a key nothing displayed.
 *
 * It is not lost: `/api/admin/billing/metrics` returns exactly the same object, on demand, to the
 * operations console built to read it — including the SLO `alerts` that used to be computed here
 * and rendered nowhere.
 *
 * `db.totalSavedQueries`, `db.totalBuilders` and `db.totalNotes` are gone for a different reason.
 * They were hardcoded `null` in this literal and rendered as three permanent em-dashes. Making them
 * real means giving `builderhunt_platform` unscoped SELECT on tenant tables — saved queries and
 * notes being private workflow content — which is the surveillance the Admin track's own rule
 * forbids. Three tiles that never had a value are better removed than powered by a new read policy
 * over other people's notes.
 */

/**
 * The fields this endpoint can compute, and what each one costs.
 *
 * `generatedAt` is not in here: it describes the response rather than being part of it, so it is always present.
 * Every other key is opt-out-able, including the two nobody currently reads — `db` and `inProcess` are what an
 * external caller of a legacy endpoint is most likely to want, and removing them is a separate decision from
 * making them optional.
 */
const METRIC_FIELDS = ['inProcess', 'db', 'removals', 'interviews', 'discovery', 'server'] as const
type MetricField = (typeof METRIC_FIELDS)[number]

export const Route = createFileRoute('/api/admin/metrics/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          /**
           * Which fields to compute. Absent means all of them.
           *
           * Refused rather than filtered, for the same reason `sections.ts` refuses an unknown section: a caller
           * that asked for `?fields=sever` and got a 200 without it would wait for a key it was never told was
           * dropped. An empty `?fields=` is also a 400 — it is a request for nothing, which is a bug at the
           * caller rather than an instruction.
           */
          const requested = new URL(request.url).searchParams.get('fields')
          let fields: ReadonlySet<MetricField> = new Set(METRIC_FIELDS)
          if (requested !== null) {
            const names = requested.split(',').map((name) => name.trim()).filter(Boolean)
            const unknown = names.filter((name) => !(METRIC_FIELDS as readonly string[]).includes(name))
            if (names.length === 0 || unknown.length > 0) {
              return Response.json(
                { error: 'invalid_request', unknownFields: unknown, allowed: METRIC_FIELDS },
                { status: 400 },
              )
            }
            fields = new Set(names as MetricField[])
          }

          // In-process metrics. Free — a read of counters already in memory — but `interviews.counters` derives
          // from it, so it is computed whenever either field is asked for.
          const needsInProcess = fields.has('inProcess') || fields.has('interviews')
          const inProcess = needsInProcess ? metrics.get() : null

          // DB aggregates
          const now = new Date()
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

          /**
           * Concurrent, not sequential: they share no data and a caller that wants several waits for all of
           * them, so awaiting them in a row just adds the faster round trips to the slowest one.
           *
           * Each is now conditional on being asked for. This is the whole point of `fields`: `?fields=server`
           * reaches the database zero times, where it previously ran both platform aggregates and the discovery
           * read to report a Node version.
           */
          const [accountMetrics, onboardingMetrics, discovery] = await Promise.all([
            fields.has('db') ? getPlatformAccountMetrics(oneDayAgo, oneWeekAgo) : null,
            fields.has('db') ? getOnboardingActivationMetrics(oneWeekAgo) : null,
            fields.has('discovery') ? getDiscoveryState().catch(() => null) : null,
          ])

          /**
           * Absent, not zero, while the feature is off.
           *
           * `PROFILE_REMOVAL_ENABLED === 'false'` means no one can file a removal request, so a `removals`
           * block reading all-zeros would be a lie of implication: a dashboard would render "0 pending" and an
           * operator would conclude the queue is empty rather than that the door is shut. Omitting the key is
           * the only answer that cannot be misread.
           */
          const removals = fields.has('removals') && env.PROFILE_REMOVAL_ENABLED === 'true'
            ? await getRemovalRequestMetrics().catch(() => null)
            : null

          /**
           * How many accounts sit in each segment (plan: phase-2/02-segmentacion-usuarios).
           *
           * Absent while `USER_SEGMENTATION_ENABLED` is `false`, for the reason `removals` is: nobody
           * can have chosen a segment yet, and a block of zeros would read as "everyone declined"
           * rather than "the question has not been asked".
           *
           * Counts only, and `unknown` is a bucket rather than a filter — a distribution that
           * silently fails to add up to the number of accounts is worse than one that admits it does
           * not recognise a stored value. Nothing here identifies anybody: the spec permits internal
           * staff to see aggregates and forbids using somebody's segment as support data.
           */
          const segments = fields.has('db') && env.USER_SEGMENTATION_ENABLED === 'true'
            ? await countUsersBySegment(publicDb).catch(() => null)
            : null

          /**
           * The interview counters, with the capability flags that decide whether they mean anything.
           *
           * Same reasoning as `removals` above, one step further. `metrics.get()` already carried all
           * nineteen interview counters, so a dashboard rendering `inProcess` could show
           * "0 booking conflicts" — which reads as "no conflicts" when the truth is that
           * `SCHEDULING_ENABLED=false` and nobody can book. The counters are only interpretable
           * alongside the doors that are open, so they travel together and `counters` is absent, not
           * zeroed, while every door is shut.
           *
           * The flags are reported individually rather than as one rolled-up boolean because they fail
           * independently: transcription can be off while scheduling is on, and an operator looking at
           * `interviewTranscriptReconnects: 0` needs to know which of those two it is.
           */
          const interviewCapabilities = {
            calendar: env.CALENDAR_ENABLED === 'true',
            scheduling: env.SCHEDULING_ENABLED === 'true',
            candidateUploads: env.CANDIDATE_UPLOADS_ENABLED === 'true',
            transcription: env.INTERVIEW_TRANSCRIPTION_ENABLED === 'true',
            sensitiveAi: env.SENSITIVE_AI_ENABLED === 'true',
          }
          const anyInterviewCapability = Object.values(interviewCapabilities).some(Boolean)

          const activationRate7d = accountMetrics && onboardingMetrics && accountMetrics.newUsersLast7d > 0
            ? onboardingMetrics.onboardingCompletedLast7d / accountMetrics.newUsersLast7d
            : null

          return Response.json({
            /**
             * When these numbers were read.
             *
             * The DB aggregates are computed per request, so without this the page can only say when
             * it *asked*, which diverges from when the server answered under exactly the load where
             * the difference matters. The billing operations console already states its own "As of";
             * this is the same claim for this page.
             */
            generatedAt: now.toISOString(),
            /*
             * Each field is present only when it was asked for, and a spread of `{}` is how a key is *absent*
             * rather than `null` — the same distinction this whole plan is about. A caller that asked for
             * `?fields=server` and received `db: null` would have to know that null means "not requested" and
             * not "no accounts", which is precisely the ambiguity `removals` is omitted to avoid.
             */
            ...(fields.has('inProcess') ? { inProcess } : {}),
            ...(fields.has('db') && accountMetrics && onboardingMetrics
              ? {
                  db: {
                    ...accountMetrics,
                    onboardingCompleted: onboardingMetrics.onboardingCompleted,
                    onboardingSkipped: onboardingMetrics.onboardingSkipped,
                    activationRate7d,
                  },
                }
              : {}),
            // plans/implemented/52-audit-trust §"Add trust runtime gates and redacted metrics" — counts and
            // states only. See `getRemovalRequestMetrics` for what is deliberately absent and why.
            ...(removals ? { removals } : {}),
            ...(segments ? { segments } : {}),
            // plans/implemented/44-calendar-scheduling-interview-intelligence §"Add redacted metrics and
            // operator dashboards". Counters and flags only: every value here is a number or a boolean,
            // which is what makes it safe to render on a page that must never approach a candidate's name.
            ...(fields.has('interviews')
              ? {
                  interviews: {
                    capabilities: interviewCapabilities,
                    ...(anyInterviewCapability && inProcess
                      ? { counters: interviewOperatorCounters(inProcess) }
                      : {}),
                  },
                }
              : {}),
            ...(fields.has('discovery')
              ? {
                  discovery: discovery && {
                    cursor: discovery.cursor,
                    lastCellKey: discovery.lastCellKey,
                    lastRunAt: discovery.lastRunAt,
                    stats: discovery.stats,
                  },
                }
              : {}),
            ...(fields.has('server')
              ? {
                  server: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    pid: process.pid,
                    memoryUsage: process.memoryUsage(),
                  },
                }
              : {}),
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin metrics error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
