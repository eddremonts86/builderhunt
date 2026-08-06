# Action-Centered Dashboard — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only after its runtime and negative authorization states are verified. Dependency-gated tasks stay open until the canonical domain capability ships.

## Wave 0 — Baseline and truth

- [ ] **Create representative authenticated dashboard fixtures**
  - Files: `tests/e2e/harness/fixtures/dashboard-personas.ts`, `tests/e2e/dashboard-and-navigation.spec.ts`, dashboard seed helpers
  - Do: Seed a new workspace, active recruiter, owner/admin, verified profile owner, and platform admin with bounded alerts, sprints, searches, builders, lists, calendar events, invitations, and plan states. Use deterministic dates/timezones and no production-like secrets or personal data.
  - Verify: each persona signs in, reloads `/dashboard`, and sees only its own organization/role projection; the app runtime role cannot mutate auth or cross-tenant fixtures.

- [ ] **Record the dashboard baseline and budgets**
  - Files: `tests/e2e/dashboard-performance.spec.ts`, test artifact configuration, `docs/operations/development.md`
  - Do: Record request count, transferred bytes, core endpoint/server timings, layout shift, accessible-name snapshot, and screenshots at desktop, 320 px, 400% zoom, reduced motion, and forced colors.
  - Verify: the baseline is reproducible against the deterministic active-recruiter fixture and fails clearly when the fixture is unavailable.

- [x] **Make widget visual order equal DOM and focus order**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, dashboard bento layout tests
  - Do: Remove dense placement for interactive widgets; render from one ordered registry and use spans that never visually promote a later DOM sibling. Preserve the same sequence in single-column layouts.
  - Verify: keyboard order equals bounding-box visual order at desktop/tablet/mobile before and after density changes; automated test covers all registered interactive widgets.

- [x] **Define a stable typed widget registry**
  - Files: `src/modules/dashboard/lib/widget-registry.ts`, `src/modules/dashboard/lib/contracts.ts`, registry unit tests
  - Do: Give every widget a stable ID, criticality, role eligibility, dependency gate, default order, default visibility, allowed spans, and state capabilities. Reject duplicate IDs and unsafe arbitrary component registration.
  - Verify: table-driven tests cover each persona, missing dependency, new workspace, and unknown/retired widget ID.
  - **Wired into the page on 2026-08-06, which it had not been.** The registry shipped with twenty
    tests and no consumer: `DashboardPage` still rendered a raw array, so role eligibility,
    dependency gating and hidden widgets did nothing. `orderedWidgets` now resolves the list before
    the layout sees it, `SHIPPED_CAPABILITIES` names the capabilities that actually exist (pipeline
    and saved-search health are not among them), and the e2e proves a hidden standard widget
    disappears while a critical one refuses to.

- [x] **Correct the current activity visualization**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, `src/routes/api/dashboard/stats.ts`, activity widget tests
  - Do: Either rename the existing `lastSeenAt` grouping to “Tracked builders last seen active” with exact scope, or replace it with newly tracked builders by `createdAt`. Add exact daily values, generated time, summary, and accessible data disclosure.
  - Verify: a builder contributes according to the chosen definition exactly once; timezone boundaries and empty days pass; no copy says “shipped” or implies event volume.

- [x] **Correct source-mix and top-metric semantics**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, dashboard stats contract/tests
  - Do: Label the current source sample explicitly or hide it until the coverage projection ships. Remove Private notes from the default metrics and resolve duplicate Search/New hunt actions. Define “active” in code and copy.
  - Verify: every visible top metric has a denominator or time window, an action, and a fixture proving its calculation.

- [x] **Distinguish every widget state**
  - Files: `src/modules/dashboard/components/WidgetFrame.tsx`, `src/modules/dashboard/lib/contracts.ts`, widget-frame tests
  - Do: Implement loading, ready, empty, partial, stale, unavailable, retryable error, and forbidden/omitted semantics with consistent actions and screen-reader text. Never translate a failed fetch into an empty array.
  - Verify: component snapshots and accessibility tests cover every state; forbidden omits capability details and unavailable never reveals secret/config values.

## Wave 1 — Core data projection

- [x] **Define versioned dashboard overview contracts**
  - Files: `src/shared/lib/dashboard/contracts.ts`, contract tests
  - Do: Define range enum, section IDs/states, generated/freshness fields, bounded row schemas, role-minimized usage summary, and allowlisted action/resource kinds. Share parsing between route and client.
  - Verify: invalid range, unknown action, arbitrary URL, excessive rows, missing freshness, and incompatible schema version fail closed.

- [x] **Build bounded dashboard aggregate repositories**
  - Files: `src/shared/lib/repositories/dashboard-overview.ts`, repository tests
  - Do: Add tenant-scoped aggregates for summary, newly tracked builders, alert volume, source coverage, active sprints, shortlists, and other current-data sections. Use indexed predicates, explicit timezones, top-N bounds, and stable ordering.
  - Verify: query-plan/SQL tests cover large representative data, shared timestamps, empty organizations, DST boundaries, and cross-tenant isolation.

- [x] **Implement `GET /api/dashboard/overview`**
  - Files: `src/routes/api/dashboard/overview.ts`, route registry, API/security tests
  - Do: Compose the core projection, return independent section states, `schemaVersion`, scope, range, and `generatedAt`; minimize billing and team fields by server-authorized role. Do not fail the whole response for an optional section.
  - Verify: member, owner/admin, signed-out, suspended, cross-tenant, partial repository failure, stale cache, and unsupported range tests pass.

- [x] **Add cache and observability boundaries**
  - Files: dashboard overview repository/route, metrics/logging configuration, tests
  - Do: Cache by organization, role class, range, and schema version with a bounded TTL; emit duration, cache, and section-status metrics without organization names, candidate identifiers, or content.
  - Verify: cache keys cannot collide across organizations/roles; invalidation/freshness labels agree; logs and metrics pass a sensitive-field snapshot.

- [~] **Refactor the page into core and lazy section queries**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, dashboard query hooks, page tests
  - Do: Fetch the core overview once; keep genuinely heavy optional widgets lazy with query keys scoped by session organization and range. Render shell/critical actions independently from lower-section failures.
  - Verify: one failed lazy request leaves the queue/navigation usable; organization switch cancels/invalidates old queries and never flashes prior-tenant content.
  - **Partial, and the remainder is blocked on test design rather than on product code.** The
    recency, source-coverage, action-queue, agenda and usage sections all read the projection. The
    three headline counts still come from `/api/dashboard/stats`.
    Migrating them was attempted and reverted on 2026-08-06: two specs intercept
    `**/api/dashboard/stats` with `page.route` — one holds it to observe the loading skeleton, one
    fulfils a 500 to observe the page-level degradation — and repointing either at
    `/api/dashboard/overview` makes it hang for the full 120 s test timeout, with `main` empty and
    the navigation never settling. Glob and regex patterns behave identically, and the same
    interception against `/api/dashboard/stats` works, so it is something about intercepting the
    request TanStack Query issues rather than about the pattern. The page-level `error` banner also
    needs a source once the fetch that sets it is gone — `overview.fatal` is the obvious one.
    Neither is a five-minute change, and leaving two specs hanging two minutes each is worse than
    leaving one endpoint in place.

## Wave 2 — Action queue

- [x] **Implement the deterministic action-rule registry**
  - Files: `src/shared/lib/dashboard/action-rules.ts`, rule tests
  - Do: Model priority, eligibility, reason code, due time, resource type/ID, expiry, dismissibility, and deduplication. Start with onboarding, pending membership invitations, unread high-value alerts, paused/completed sprints, and role-safe usage thresholds.
  - Verify: table-driven tests cover priority ties, expiry, duplicate underlying resources, unauthorized fields, and clock boundaries.

- [x] **Expose action items through the overview projection**
  - Files: dashboard overview repository/route/contracts, API tests
  - Do: Return a bounded ordered list of action kinds and resource IDs. Never return arbitrary URLs; never include note text, transcript content, candidate email, payment details, or raw provider metadata.
  - Verify: DTO redaction snapshot and tenant/role negative tests pass; each resource is re-authorized on its destination route.

- [x] **Build the Action Queue widget**
  - Files: `src/modules/dashboard/components/ActionQueueWidget.tsx`, typed dashboard route mapper, component tests
  - Do: Render why, severity text, due/age context, and one primary action. Resolve only allowlisted route kinds; render unknown kinds safely as unavailable. Add loading/empty/stale/error states.
  - Verify: keyboard, screen-reader, touch-target, 320 px, long localization, and unknown-action fixtures pass.

- [ ] **Unify onboarding and invitation notices with the queue**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, onboarding/invitation banner components, E2E tests
  - Do: Remove duplicate banners after their equivalent queue rules ship. Preserve blocking/critical behavior and valid dismissals; do not allow required actions to be hidden through preferences.
  - Verify: each underlying issue appears exactly once, dismissal applies only to eligible informational items, and resolution removes the item after refresh.

- [ ] **Add privacy-safe queue telemetry**
  - Files: dashboard analytics events/contracts, telemetry tests
  - Do: Track allowlisted widget/action kind, position, continuation, dismissal, and resolution correlation without resource IDs, candidate data, free text, or organization labels.
  - Verify: event-schema tests reject unknown fields and sensitive fixture strings; telemetry failure never blocks the action.

## Wave 3 — Upcoming work

- [x] **Build the upcoming schedule projection**
  - Files: `src/shared/lib/repositories/dashboard-upcoming.ts`, dashboard overview adapter, repository tests
  - Do: Merge Calendar, Interview, and booked Scheduling records by canonical event/interview identifiers; return the next bounded items with local display context and authorized action state.
  - Verify: duplicate, cancelled, rescheduled, all-day, DST, shared-access, foreign-tenant, and missing-meeting-link fixtures pass.

- [x] **Build the Today and Upcoming widget**
  - Files: `src/modules/dashboard/components/UpcomingWidget.tsx`, component/E2E tests
  - Do: Render a semantic agenda with timezone, start/end, status, and context-aware Join/Prepare/View action. Prefer the agenda over a chart; allow a compact week strip only as a redundant summary.
  - Verify: focus order follows chronological order; 320 px/400% zoom reflow, screen-reader labels, external-link safety, and empty/offline states pass.

- [x] **Add interview-readiness and scheduling action rules**
  - Files: dashboard action rules, interview/scheduling adapters, tests
  - Do: Add imminent interview missing brief, invitation needing organizer action, calendar conflict, and missing availability rules. Use the canonical readiness/state machines rather than client guesses.
  - Verify: valid state/time windows, reschedule, cancellation, shared access, owner/member permissions, and expiry pass.

- [~] **Connect dashboard schedule actions to canonical destinations**
  - Files: typed route mapper, Calendar/Interview/Invitation routes, navigation E2E tests
  - Do: Continue to event detail, brief, live interview, invitation hub, or validated meeting URL; preserve allowlisted same-origin `from` context for the return path.
  - Verify: each state exposes only legal actions; external/protocol-relative/script URLs are rejected and cross-tenant IDs remain undiscoverable.
  - **Partial.** `action-routes.ts` maps every allowlisted kind to a real destination and refuses an
    unknown one (no button, rather than a guess). Meeting links are validated as absolute http(s) at
    the contract boundary and opened with `noopener noreferrer`. Two destinations were corrected
    against the router while writing it: `/calendar/availability` does not exist (the editor is on
    `/calendar`), and invitations are rows on one hub rather than routes. **Not done:** the
    allowlisted same-origin `from` context for the return path.

## Wave 4 — Current-data widgets and charts

- [~] **Build Candidates to Review as a unified projection**
  - Files: dashboard review projection/contracts, `CandidatesToReviewWidget.tsx`, tests
  - Do: Combine bounded recommendations, unread alert matches, completed sprint results, and recent tracked builders while preserving provenance and deduplicating identities. Rank with deterministic product rules, not unexplained generated prose.
  - Verify: one candidate is not repeated, the reason/source remains visible, and primary navigation enters the internal builder workspace with safe origin context.
  - **Partial: live recommendations stay out, deliberately.** `GET /api/recommendations` re-runs the
    saved queries through the federated pipeline — thirteen connectors, an 8 s per-connector budget,
    its own rate limit. The overview is cached 30 s and read on every dashboard load, so folding that
    in would put the pipeline behind every page view for rows that change on the timescale of a saved
    search. The projection merges unread alert matches and untracked results from completed sprints,
    deduplicated by `(source, sourceId)` with the more actionable provenance winning. A person can
    still appear once here and once in the recommendations widget; closing that needs recommendations
    to become a cached projection of its own.

- [x] **Add newly tracked discovery trend**
  - Files: dashboard aggregate repository, `DiscoveryTrendWidget.tsx`, chart tests
  - Do: Aggregate organization-builder creation by local day for the selected range; render daily bars/line, exact summary, and data disclosure.
  - Verify: exact totals match the table, missing days render zero, timezone boundaries pass, and copy does not imply quality or hiring conversion.

- [x] **Add alert-trigger volume**
  - Files: dashboard aggregate repository, `AlertVolumeWidget.tsx`, chart tests
  - Do: Aggregate trigger timestamps by day and allowlisted type; stack only when types are understandable/actionable. Link to Alerts with validated filters.
  - Verify: acknowledgement state does not change historical volume, type totals reconcile, high-volume data remains bounded, and exact values are keyboard accessible.

- [x] **Build canonical Source Coverage**
  - Files: dashboard aggregate repository, `SourceCoverageWidget.tsx`, source registry, tests
  - Do: Choose and label one denominator: all tracked builders or configured saved-search sources. Render ranked bars/100% stack plus exact values and source-filtered Search continuation.
  - Verify: percentage rounding reconciles, unknown sources have safe metadata, empty denominator is explicit, and recent-sample data is no longer presented as workspace coverage.

- [x] **Build the Shortlists summary**
  - Files: dashboard overview adapter, `ShortlistsWidget.tsx`, list routes/tests
  - Do: Show recent/top lists, exact counts, updated time, and uncategorized work only when the source definition is reliable. Link to list detail and All Shortlists.
  - Verify: private/organization visibility, deleted list, zero list, equal timestamps, and foreign list fixtures pass.

- [x] **Build human Team Activity summary**
  - Files: dashboard activity adapter, `TeamActivityWidget.tsx`, activity tests
  - Do: Use server-derived actor display labels and allowlisted target kinds from `plans/UI`. Render recent events; add a volume chart only after a bounded typed event aggregate exists.
  - Verify: deleted/inaccessible targets are plain text, raw IDs are absent, event volume is not framed as employee performance, and pagination/order is stable.

- [x] **Replace legacy Plan Usage with canonical Workspace Usage**
  - Files: dashboard billing adapter, `WorkspaceUsageWidget.tsx`, billing tests
  - Do: Consume `/api/billing/summary` or its shared service; show plan/credit/seat progress appropriate to role. Financial amounts and management actions remain owner/admin-only.
  - Verify: member, owner/admin, free, paid, past-due, manual exception, unlimited, and stale-billing fixtures pass without field leakage.

## Wave 5 — Dependency-gated widgets

- [ ] **Integrate Saved-Search Health without fabricated history**
  - Files: saved-search health dashboard adapter, `SavedSearchHealthWidget.tsx`, contract tests
  - Depends on: `plans/phase-4/saved-search-health`
  - Do: Show current healthy/tune/kill/unmonitored/too-new counts and a bounded issue list with tune/inspect/retire continuations. Do not persist dashboard-owned snapshots or draw a trend.
  - Verify: dashboard totals reconcile with the canonical health endpoint and no trend/time-series UI exists.

- [ ] **Integrate Pipeline Stage Distribution and aging**
  - Files: pipeline dashboard adapter, `PipelineSnapshotWidget.tsx`, contract tests
  - Depends on: `plans/phase-4/hiring-pipeline-kanban`
  - Do: Show canonical stage counts and supported aging/stuck indicators with exact values. Use “distribution”; link to the filtered Kanban.
  - Verify: counts reconcile, missing stage-entry timestamps suppress aging, and no funnel/conversion language exists without transition cohorts.

- [x] **Integrate Invitation Status Distribution**
  - Files: invitation dashboard adapter, `InvitationStatusWidget.tsx`, tests
  - Depends on: central invitation management in `plans/UI`
  - Do: Show current draft/sent/opened/booked/declined/revoked counts and organizer follow-ups; link to filtered invitation management.
  - Verify: current-state counts reconcile, unauthorized candidate email is absent, and copy says snapshot/status rather than funnel/conversion.

- [ ] **Add an optional verified-profile-owner summary**
  - Files: claimed-profile dashboard adapter/widget, `/me` analytics contracts, tests
  - Depends on: profile analytics in `plans/UI`
  - Do: Register an opt-in widget for verified owners with publication state, privacy-safe aggregate views, and Manage profile continuation. Keep full analytics in `/me`.
  - Verify: non-owner/unverified/minimum-cohort cases reveal no analytics or widget eligibility; no viewer identities enter API or DOM.

- [ ] **Add contextual service degradation only**
  - Files: dashboard shell/status adapter, tests
  - Do: Show a compact notice and Status link when a user-facing dependency is degraded. Keep worker, integration, trust, billing operations, and platform metrics in their dedicated Admin pages.
  - **Built and reverted, 2026-08-06.** The only degradation signal is `GET /api/status`, which
    answers **503** when degraded — correctly, for monitors. A browser logs every non-2xx subresource
    to the console, so polling it from the dashboard put two console errors on every load during an
    incident, which the sign-in e2e's strict collector caught immediately. It also adds a real
    health-check poll per session. Blocked on a 200-answering degradation signal; `/api/health` is a
    liveness probe that deliberately touches no dependency, so it cannot serve. The value in the
    meantime is small: `/status` is already in the navigation.
  - Verify: healthy state renders no permanent status widget; degraded copy matches measured checks and never fabricates a healthy/failed component.

## Admin track — Specialized organization and platform widgets

- [ ] **Define separate organization-admin and platform-admin contracts**
  - Files: `src/shared/lib/dashboard/admin-contracts.ts`, contract/security tests
  - Do: Define stable widget/section/action kinds, range, freshness, units, thresholds, redacted issue rows, and section states for organization administration and platform operations. Use separate schema names and response roots; reject arbitrary URLs and unknown action kinds.
  - Verify: schema snapshots prove that tenant and platform DTOs are not assignable/interchangeable; sensitive marker and excessive-row fixtures fail closed.

- [ ] **Build the organization-admin overview projection**
  - Files: `src/shared/lib/repositories/dashboard-organization-admin.ts`, dashboard overview route/adapter, repository/API tests
  - Do: Add tenant-scoped members/seats, elevated-role/ownership state, canonical billing/entitlement status, blocked workflow counts, feature setup/adoption, security posture, and eligible privacy/data-request counts. Minimize every field by owner/admin authority.
  - Verify: member/admin/owner, suspended user, pending ownership, cross-tenant, financial-field, private-content, and empty-workspace fixtures pass.

- [ ] **Build the Organization Admin widget section**
  - Files: `src/modules/dashboard/components/admin/OrganizationAdminSection.tsx`, widget registry, component/E2E tests
  - Do: Register Members and seats, Roles/access review, Billing and entitlements, Team coordination, Workspace adoption, Security posture, and eligible Data/privacy widgets after the normal workflow sections. Promote critical issues into the shared queue and link to canonical settings/workflows.
  - Verify: ordinary members see no section or capability hints; admins see only allowed status; owners receive owner-only finance/actions; keyboard/mobile order remains aligned.

- [ ] **Prevent organization-admin surveillance metrics**
  - Files: organization-admin repository/contracts, analytics schema, security tests
  - Do: Prohibit individual productivity, search/note/activity rankings, private workflow content, candidate emails, session detail, and member-level adoption scores. Keep coordination object-based and adoption organization-aggregated.
  - Verify: DTO/DOM/telemetry snapshots reject member score/rank fields and seeded sensitive strings; small-team states do not expose inferable individual activity.

- [~] **Create the Platform Admin Command Center route and projection**
  - Files: `src/routes/_dashboard/admin/index.tsx`, `src/routes/api/admin/overview.ts`, `src/shared/lib/repositories/admin-overview.ts`, navigation/route registry, API/E2E tests
  - Do: Add `/admin` as the Admin landing page and `GET /api/admin/overview?range=24h|7d|30d`. Return a platform action queue plus independent redacted section states for incidents, operations, billing, abuse/trust, user anomalies, growth, and public content.
  - Verify: platform admin can load/reload/deep-link; organization admins, members, signed-out users, and guessed resource IDs fail without confirming existence.
  - **Scope changed by the maintainer, 2026-08-06: "índice = metrics".** `/admin` is no longer a new
    destination; it is an index that resolves to `/admin/metrics`, which is the page operators
    already read. Shipped in `src/routes/_dashboard/admin/index.tsx` — before it, the bare `/admin`
    URL answered **404** even though `nav-config.ts` registers the area at that prefix.
    The attention summary this task describes still gets built, but *on* the Metrics page rather than
    beside it: a separate summary whose every tile mirrors a page it summarises rots first, and this
    repository has the receipt — `/admin/integrations` showed two retired sources as ACTIVE because
    it was assembled from a compile-time registry nobody updated. Remaining work is therefore
    `GET /api/admin/overview` and the sections, folded into the Metrics rebuild below.

- [ ] **Reconcile stale and future Admin destinations**
  - Files: `src/modules/dashboard/ui/shell/nav-config.ts`, Admin routes, `plans/UI`, navigation tests
  - Do: Remove or redirect retired Plan requests instead of creating a widget for it; register Command Center, Operations, Integrations, Claims/Trust, and other destinations only when their canonical projections/pages ship. Keep one authoritative Admin route registry.
  - Verify: every visible Admin destination resolves for a platform admin, no retired/dependency-disabled item appears, direct unauthorized access fails, and route coverage reports no orphan Command Center continuation.

- [ ] **Build the Platform Action Queue and service-health widgets**
  - Files: `src/modules/admin/dashboard/AdminDashboardPage.tsx`, `PlatformActionQueue.tsx`, `ServiceHealthWidget.tsx`, tests
  - Do: Prioritize critical incidents/security/abuse, money/entitlement failures, user-impacting failed workers, policy deadlines, configuration anomalies, then non-critical product signals. Render measured status and incident aging with one safe drill-down per item.
  - Verify: severity/age ordering, expiry/deduplication, degraded status, partial failure, unknown destination, long incident copy, keyboard, screen reader, and mobile fixtures pass.

- [ ] **Build Worker and Integration Health admin widgets**
  - Files: admin overview adapter, `WorkerHealthWidget.tsx`, `IntegrationHealthWidget.tsx`, tests
  - Depends on: Operations and Integrations projections from `plans/UI`
  - Do: Show registered schedule state, last/next run, overdue/failed/paused conditions, bounded duration/error changes, quota/backlog where measured, and credential-present boolean only when authorized. Link to Operations/Integrations, never directly to worker API routes.
  - Verify: failed/overdue/running/paused/healthy/dormant states, incomparable history, unknown job keys, redaction, and source-registry completeness pass.

- [ ] **Build Billing, Abuse, Trust, and User Anomaly admin widgets**
  - Files: admin overview adapters, admin dashboard widget components, tests
  - Depends on: bounded discovery projections for billing events, claims/trust queues, and operations from `plans/UI`
  - Do: Show canonical billing alerts, refund/dispute aging, reconciliation/dead-letter status, redacted abuse-risk distribution, trust/removal deadline aging, and entitlement/account anomalies. Keep mutations on canonical detail pages.
  - Verify: raw provider payloads, payment data, abuse evidence, subject/candidate content, tokens, stack traces, and arbitrary mutation endpoints never enter the API or DOM; each row opens an authorized detail destination.

- [ ] **Build Growth, Conversion, and Public Content admin widgets**
  - Files: admin metrics/content adapters, admin dashboard widget components, tests
  - Do: Render conversion only from canonical ordered events with denominator/window/exclusions and insufficient-cohort states. Show content publishing/incident-communication aging as an operational checklist; omit vanity page-view panels.
  - Verify: cohort totals reconcile; empty/insufficient/degraded cases avoid fabricated rates; no causal language is generated; content actions remain on their audited detail pages.

### `/admin/metrics` optimization

- [ ] **Measure the current Admin Metrics query and refresh cost**
  - Files: `tests/performance/admin-metrics.spec.ts`, metrics test fixtures, performance notes
  - Do: Record endpoint duration, database query count, cross-organization billing reads, transferred bytes, client request overlap, and 15-second hidden-tab behavior for small and representative large fixtures. Identify which response fields the current page actually renders.
  - Verify: baseline proves whether one page load invokes `getBillingOperationsMetrics`, how cost grows with organizations/grants, and whether repeated polls overlap; fixture/results contain no production data.

- [ ] **Define versioned Admin Metrics section contracts**
  - Files: `src/shared/lib/admin-metrics/contracts.ts`, contract tests
  - Do: Define Overview, Traffic, Search, Discovery, Activation, Conversion, Feature reliability, and Runtime section schemas with status, generated time, window/timezone, source scope, reset/process identity, units, thresholds, bounded series, and ranked rows.
  - Verify: tests reject missing units/scope, more than 90 buckets/10 ranked rows, arbitrary route labels, invalid thresholds, unknown variants, and process counters presented as persisted platform totals.

- [ ] **Split the monolithic Admin Metrics API and remove frequent billing scans**
  - Files: `src/routes/api/admin/metrics/index.ts`, `src/routes/api/admin/metrics/overview.ts`, section routes/repository, API/performance tests
  - Do: Make Overview lightweight; load analytical sections only by validated request. Remove `getBillingOperationsMetrics` from the frequent Metrics path and consume only a cached Admin-overview billing alert summary. Preserve detailed billing computation under `/api/admin/billing/metrics`. Migrate the UI/regression consumers, then retain only a bounded documented legacy compatibility response until removal.
  - Verify: initial Overview, 60-second refresh, and legacy compatibility request perform no organization billing sweep or conversion query; one section failure returns its state without failing ready sections; current route regression coverage is migrated; platform role remains required everywhere.

- [ ] **Add truthful historical service-metric storage or adapter**
  - Files: metrics repository/schema or observability adapter, retention/aggregation worker, tests and runbook
  - Do: Persist bounded time buckets or integrate a real metrics backend for request counts, errors, latency histograms, search/cache outcomes, and allowlisted route families. Record instance/deployment/reset identity and retention. Do not infer history from cumulative process counters.
  - Verify: rates and p50/p95/p99 reconcile with fixture observations across process restart and multiple instances; high-cardinality URLs/IDs are normalized or rejected; retention is bounded.

- [ ] **Rebuild `/admin/metrics` as a route-driven lazy widget shell**
  - Files: `src/routes/_dashboard/admin/metrics.tsx`, `src/modules/admin/metrics/AdminMetricsPage.tsx`, query hooks, UI tests
  - Do: Add Overview, Traffic, Search/Discovery, Activation, Conversion, Feature reliability, and Runtime sections with validated `section`, `range`, `variant`, and comparison URL state. Fetch only the visible section; cancel/dedupe overlap, pause polling in hidden tabs, and show last success/stale/retry state.
  - Verify: direct/bookmarked filters restore correctly; invalid values normalize safely; hidden section requests do not fire; organization admins/non-admins remain denied; manual refresh has an accessible result announcement.

- [ ] **Build Request Health and bottleneck widgets**
  - Files: Admin Metrics traffic components/repository, tests
  - Depends on: truthful historical service-metric storage or adapter
  - Do: Render request rate, error ratio, p50/p95/p99 latency, and bounded slow/error route-family rankings with exact values, comparison, thresholds, and Operations/Incident drill-downs.
  - Verify: values/units/time buckets reconcile, zero traffic is distinct from missing instrumentation, normalized route families reveal no identifiers, and no percentile appears without histogram data.

- [ ] **Build Search and Discovery metrics widgets**
  - Files: Admin Metrics search/discovery components/repositories, tests
  - Do: Render searches, eligible cache lookups/hits/misses/hit rate, search latency/errors, discovery run/upsert/error/duration/backlog state, and last/next run. Label every value as bounded-window, current-run, or lifetime and keep cursor/cell keys in a diagnostic disclosure.
  - Verify: cache-rate denominator and discovery totals reconcile; worker-never-run, dormant, failed, stale, and unavailable states are distinct; actions link to Search, Operations, or Integrations rather than worker APIs.

- [ ] **Build cohort-correct Acquisition and Activation widgets**
  - Files: Admin Metrics activation repository/components, tests
  - Do: Compute new accounts, eligible signups, onboarding completed/skipped, and activation from one documented cohort/window. Remove null total Saved queries/Builders/Notes cards unless real aggregates with a decision are added.
  - Verify: cohort boundaries, zero denominator, consent exclusion, delayed onboarding, UTC days, and comparison-period fixtures pass; lifetime totals are never divided by recent signups.

- [ ] **Optimize and render Conversion metrics**
  - Files: `src/routes/api/admin/metrics/conversion.ts`, conversion repository, Admin Metrics conversion components, `tests/unit/routes/admin/metrics.test.tsx`, conversion API/performance tests
  - Depends on: conversion UI work in `plans/UI`
  - Do: Aggregate required event counts in one bounded query/batch; enforce start <= end, maximum 90 days, UTC-day range, valid variant, and consent cohort. Render numerator, denominator, rate, CI95, insufficient-sample state, variant comparison, and exact table without causal language.
  - Verify: query count stays constant as metric definitions grow; six canonical metrics reconcile with repository fixtures; invalid/reversed/oversized ranges fail; insufficient cohorts suppress misleading emphasis.

- [ ] **Build Feature Reliability metrics with interview signals first**
  - Files: Admin Metrics feature-reliability repository/components, `src/shared/lib/metrics.ts`, tests
  - Do: Group booking conflicts, document backlog/failure, transcript reconnect/retry, provider/parse/fallback/refusal, stale schedule/reservation, usage variance, and retention failure into actionable thresholds. Use persisted buckets when available; otherwise label the per-process reset scope.
  - Verify: no candidate/interview IDs or content enter DTO/DOM/logs; each breached threshold links to the correct feature/Operations runbook; unsupported capture is labeled a support signal rather than an error.

- [ ] **Demote Runtime diagnostics and add Data Freshness**
  - Files: Admin Metrics runtime/freshness components and contracts, tests
  - Do: Move Node/platform/PID/memory/uptime into a collapsed per-instance diagnostic panel. Add a visible freshness matrix for each source, including generated time, last success, stale threshold, unavailable reason, process start/reset, and partial state.
  - Verify: Runtime is not presented as platform health; multiple-instance/reset fixtures are explicit; zero, stale, reset, unavailable, and error remain distinguishable without color.

- [ ] **Add Admin Metrics accessibility, performance, and regression gates**
  - Files: Admin Metrics component/E2E/accessibility/visual/performance tests, CI configuration
  - Do: Cover exact chart tables, summaries, legends, units, thresholds, URL filters, keyboard/touch, 320 px, 400% zoom, forced colors, reduced motion, partial failure, long labels, lazy requests, and query/payload budgets.
  - Verify: Overview p95 <= 400 ms and one cached analytical section p95 <= 750 ms on the representative fixture; no overlapping request, hidden polling, billing sweep, unbounded range, sensitive route label, or chart-only value passes CI.

### Admin preferences and release gates

- [ ] **Persist isolated platform-admin preferences**
  - Files: admin dashboard preference schema/repository/API, customization UI, security tests
  - Do: Store platform layout/range separately from organization dashboard preferences. Fix required Incident, Security/Abuse, and Billing-risk widgets; allow optional Growth/Content widgets to move/hide through keyboard-accessible controls.
  - Verify: platform and tenant preferences cannot overwrite/read each other; required-widget hiding fails; version migration, stale update, keyboard reorder, reset, and shared-browser account switch pass.

- [ ] **Add admin scope, audit, and performance release gates**
  - Files: admin dashboard contract/E2E/accessibility/performance tests, rollout runbook
  - Do: Test platform-role and organization-role boundaries, cross-scope caches, redacted telemetry/logs, per-section failures, accessible charts, bounded queries, and independent feature flags. Confirm destructive/outward-facing operations are absent from the Command Center.
  - Verify: authenticated desktop/mobile runtime passes for organization admin, owner, platform admin, and negative personas; disabling either admin surface preserves all existing detailed routes.

## Wave 6 — Personalization

- [x] **Persist versioned per-user/per-organization preferences**
  - Files: database schema/migration, preferences repository, `src/routes/api/dashboard/preferences.ts`, security tests
  - Do: Store version, density, range, ordered/hidden/pinned stable widget IDs with optimistic versioning and bounded payload size. Migrate local density once without cross-user leakage.
  - Verify: user/org isolation, stale update, unknown ID, duplicate ID, required-widget hiding, size limit, and schema migration tests pass.
  - **Shipped.** `dashboard_preferences` holds density, hidden, pinned and ordered ids per
    (organization, user), with RLS and grants in `0151`/`0152` and the ordering columns in `0153`.
    `GET`/`PUT /api/dashboard/preferences`, one Zod contract parsed on both sides, and an optimistic
    client. The e2e proves the round trip through `builderhunt_app` with RLS on rather than through a
    superuser connection, which is what three earlier defects in this repository needed and did not
    have.
  - **Two version numbers, because they answer different questions.** `schemaVersion` describes the
    document's shape and changes when a deploy changes it; `revision` counts writes and changes on
    every save. Collapsing them — the first thing I tried — makes "does this need migrating?" and "did
    somebody else save while I was editing?" the same question, and they have different remedies.
  - **Optimistic concurrency exists for ordering, not for hides.** For a hide, last-write-wins loses
    one toggle and there is nothing to reconcile. A move is expressed as a whole sequence, so two tabs
    each moving a different widget produce two complete arrangements and the loser's *entire layout*
    is discarded. The `WHERE revision = ?` rides on the upsert rather than following a `SELECT`,
    because a check between a read and a write has a window in which the other tab commits — the exact
    race the revision exists to close. The 409 carries the winning document so the loser can adopt it
    in the same round trip instead of showing a stale arrangement until a refetch lands.
  - **No `range` and no `localStorage` import.** The dashboard has no user-selectable range to store —
    every projection window is fixed by its own contract — so a `range` column would be a field
    nothing writes and nothing reads. The one-time import is deliberately skipped: the value it would
    carry over is a single density flag on whichever browser the user happens to open next, and the
    code to read it would have to survive forever to be worth anything.

- [x] **Build accessible dashboard customization controls**
  - Files: `DashboardCustomizeDialog.tsx`, widget registry/page, component/E2E tests
  - Do: Implement Pin/Unpin, Hide/Show, Move up/down, density, range, and Reset. Restore focus on close and announce reorder results. Drag, if present, invokes the same commands and is never required.
  - Verify: keyboard/touch/screen-reader flows pass; unsaved/error/offline recovery preserves the last valid layout.
  - **Shipped.** `DashboardCustomizeDialog`: density as a radio group, one named switch per widget,
    and Reset. Critical widgets are listed, locked and explained rather than omitted — a user who
    cannot find "Needs your attention" concludes the dialog is broken, and offering a switch would
    offer an action `orderedWidgets` silently ignores. Nothing is a form: every change applies through
    the optimistic store, so there is no unsaved state and no way for the dialog and the page behind
    it to disagree.
  - **Pin, Unpin and Move up/down ship with it.** Every reorder announces itself through a live region
    that names the widget and its new position, counting only positions a user can actually move
    through — that region is the entire feedback channel for someone who cannot see the row move, and
    "moved" on its own tells them nothing. Boundary controls are disabled rather than removed, because
    a control that vanishes slides every button after it out from under the pointer and the focus.
    Critical widgets are locked against all four operations: `contracts.ts` says they cannot be hidden
    *or reordered*, and honouring only the first half would let a user push the action queue below the
    charts without confirming anything.
  - **No range control, for the reason above.** Drag is still absent, still deliberately: the commands
    exist first, and a drag affordance can invoke them later.
  - **Two defects the rendered dialog exposed and no test would have.** It listed "Run your first
    hunt" — the empty-workspace CTA that `isVisible` had already dropped from a workspace with
    builders — so every announced position after it was one out; the layout's own predicate is now
    exported as `rendersForData` and asked by both. And "Saved searches" appeared twice, the metric
    tile and the widget, indistinguishable once the dialog strips the context that told them apart;
    `defineWidgetRegistry` now throws on a duplicate title the way it already threw on a duplicate id.

- [~] **Apply persona defaults and safe preference migration**
  - Files: widget registry defaults/migration, tests
  - Do: Define deterministic defaults for new user, recruiter/member, owner/admin, verified profile owner, and platform admin. Append newly required widgets and ignore retired IDs without scrambling user order.
  - Verify: golden preference fixtures migrate across versions and organization switches never reuse another organization's layout.
  - **The migration half is done.** `mergeWidgetOrder` drops ids with no widget behind them and places
    a widget the saved order has never seen **after every widget it follows in the registry** — not
    appended, which is the obvious reading of "append newly required widgets" and is wrong the first
    time a new widget belongs near the top. "After every predecessor" rather than "after the nearest
    one" was a unit test's correction of my first rule: the two differ exactly when the user has
    reordered, and the nearest-predecessor version contradicted registry relations the user had never
    touched. No saved pair ever swaps, checked as a relation over every pair rather than against one
    expected array. `migratePreferenceDocument` covers the version axis, including a document from a
    *newer* build, which is read for what this build understands rather than discarded — a rollback
    should not hand somebody the default layout.
  - **The persona-defaults half is deliberately empty, and that is the finding.** Every difference the
    spec's persona list names is already expressed somewhere better: role differences by `roles` on
    the widget, so a member never sees Workspace usage and is never offered it back; the new-workspace
    case by `isVisible` and `whenEmpty: 'hide'`, so an empty chart is absent while it is empty and
    returns the day there is data. A persona hide table would encode the same decisions a second time
    and *worse* — a widget hidden by persona default stays hidden after the workspace stops being new,
    which is precisely the bug the data-driven version does not have. Verified-profile-owner and
    platform-admin defaults are absent because neither persona has shipped widgets on this route to
    have defaults about. Left partial rather than closed: the mechanism to apply a default set exists
    and is unused, and if a real persona difference appears it belongs here.

## Wave 7 — Shared visualization, quality, and release

- [ ] **Create accessible visualization primitives**
  - Files: `src/modules/dashboard/components/charts/*`, chart tests/story fixtures
  - Do: Provide bars, stacked/segmented bars, progress meters, summaries, legends, and exact-data disclosures using small CSS/SVG primitives. Avoid a chart dependency unless measured complexity justifies it.
  - Verify: no color-only meaning, SVG marks are not noisy focus targets, keyboard/touch equivalents exist, and forced-colors/reduced-motion snapshots pass.

- [ ] **Complete responsive and assistive-technology coverage**
  - Files: dashboard styles/components, accessibility regression tests
  - Do: Audit semantic regions/headings, focus order, visible focus, target sizes, live regions, 320 px reflow, 400% zoom, long labels, forced colors, reduced motion, and screen-reader chart summaries.
  - Verify: automated WCAG checks plus manual VoiceOver/NVDA-class checklist pass for empty, populated, partial failure, stale, and customized dashboards.

- [ ] **Enforce dashboard performance budgets**
  - Files: dashboard query code, build/performance tests, CI configuration
  - Do: Enforce bounded points/rows, payload and request budgets, p95 core projection target, stable skeleton dimensions, lazy optional sections, and chart bundle limits.
  - Verify: representative large fixture meets budgets; CI fails on unbounded queries, major bundle regression, excessive requests, or layout-shift threshold.

- [ ] **Add persona E2E and visual regression suites**
  - Files: `tests/e2e/dashboard-and-navigation.spec.ts`, dashboard visual specs/fixtures
  - Do: Cover first hunt, active recruiter, owner/admin usage pressure, upcoming interview readiness, partial failure, stale data, dependency-disabled state, preferences, and platform-admin contextual notice at desktop/mobile.
  - Verify: each primary widget continuation reaches its canonical destination and Back returns to the safe dashboard context.

- [ ] **Add tenant, role, privacy, and URL security gates**
  - Files: dashboard API/security tests, safe-route tests
  - Do: Snapshot every dashboard DTO by role, attempt cross-tenant resource IDs, verify server-side minimization, reject arbitrary/external action URLs, and scan telemetry/DOM/log fixtures for sensitive markers.
  - Verify: all negative cases fail closed without confirming resource existence or emitting private data.

- [ ] **Instrument and stage the release**
  - Files: feature flags, dashboard telemetry, rollout/runbook docs
  - Do: Gate overview consumption, action queue, dependent widgets, and personalization independently. Define observation windows, rollback thresholds, and privacy-safe success events.
  - Verify: each flag disables cleanly at runtime; rollback restores the corrected baseline dashboard without losing domain data or blocking navigation.

- [ ] **Run the final cross-plan reconciliation**
  - Files: this plan, `plans/UI`, dependent Phase 4 plans, navigation/route docs
  - Do: Re-audit current code and completed dependency tasks; remove obsolete assumptions, confirm widget ownership, copy scopes, canonical links, and unresolved open dependencies.
  - Verify: typecheck, lint, unit, integration, route coverage, authenticated E2E, accessibility, visual, performance, and tenant-isolation gates pass; verify the built app manually before changing this plan status to complete.
