import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { interviewOperatorCounters, metrics } from '~/shared/lib/metrics'
import { getOnboardingActivationMetrics, getPlatformAccountMetrics } from '~/shared/lib/repositories/platform-billing'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'
import { env } from '~/shared/lib/env'
import { getRemovalRequestMetrics } from '~/shared/lib/repositories/profile-removal'

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
export const Route = createFileRoute('/api/admin/metrics/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          // In-process metrics
          const inProcess = metrics.get()

          // DB aggregates
          const now = new Date()
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

          // Concurrent, not sequential: they share no data and the page waits for all three, so
          // awaiting them in a row just adds the two faster round trips to the slowest one.
          const [accountMetrics, onboardingMetrics, discovery] = await Promise.all([
            getPlatformAccountMetrics(oneDayAgo, oneWeekAgo),
            getOnboardingActivationMetrics(oneWeekAgo),
            getDiscoveryState().catch(() => null),
          ])

          /**
           * Absent, not zero, while the feature is off.
           *
           * `PROFILE_REMOVAL_ENABLED === 'false'` means no one can file a removal request, so a `removals`
           * block reading all-zeros would be a lie of implication: a dashboard would render "0 pending" and an
           * operator would conclude the queue is empty rather than that the door is shut. Omitting the key is
           * the only answer that cannot be misread.
           */
          const removals = env.PROFILE_REMOVAL_ENABLED === 'true'
            ? await getRemovalRequestMetrics().catch(() => null)
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

          const activationRate7d = accountMetrics.newUsersLast7d > 0
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
            inProcess,
            db: {
              ...accountMetrics,
              onboardingCompleted: onboardingMetrics.onboardingCompleted,
              onboardingSkipped: onboardingMetrics.onboardingSkipped,
              activationRate7d,
            },
            // plans/implemented/52-audit-trust §"Add trust runtime gates and redacted metrics" — counts and
            // states only. See `getRemovalRequestMetrics` for what is deliberately absent and why.
            ...(removals ? { removals } : {}),
            // plans/implemented/44-calendar-scheduling-interview-intelligence §"Add redacted metrics and
            // operator dashboards". Counters and flags only: every value here is a number or a boolean,
            // which is what makes it safe to render on a page that must never approach a candidate's name.
            interviews: {
              capabilities: interviewCapabilities,
              ...(anyInterviewCapability ? { counters: interviewOperatorCounters(inProcess) } : {}),
            },
            discovery: discovery && {
              cursor: discovery.cursor,
              lastCellKey: discovery.lastCellKey,
              lastRunAt: discovery.lastRunAt,
              stats: discovery.stats,
            },
            server: {
              nodeVersion: process.version,
              platform: process.platform,
              pid: process.pid,
              memoryUsage: process.memoryUsage(),
            },
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
