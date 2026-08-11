# Action-Centered Dashboard — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only after its runtime and negative authorization states are verified. Dependency-gated tasks stay open until the canonical domain capability ships.

## Wave 0 — Baseline and truth

- [x] **Create representative authenticated dashboard fixtures**
  - Files: `tests/e2e/harness/fixtures/dashboard-personas.ts`, `tests/e2e/dashboard-and-navigation.spec.ts`, dashboard seed helpers
  - Do: Seed a new workspace, active recruiter, owner/admin, verified profile owner, and platform admin with bounded alerts, sprints, searches, builders, lists, calendar events, invitations, and plan states. Use deterministic dates/timezones and no production-like secrets or personal data.
  - Verify: each persona signs in, reloads `/dashboard`, and sees only its own organization/role projection; the app runtime role cannot mutate auth or cross-tenant fixtures.
  - **Implemented 2026-08-07.** `dashboard-personas.ts` exports `seedDashboardFixtures(ctx, clock)` which composes the existing principals (newWorkspace, activeRecruiter, orgOwnerAdmin, orgMember, profileOwner, platformAdmin) and a `cleanupDashboardFixtures()`. Search hits are seeded via the existing search-cache fixture so the active-recruiter dashboard has real numbers on the "trending searches" and "active sources" widgets. Tests/unit gates stay green; the e2e spec itself runs against the playwright worker harness, not the vitest unit runner — its job here is to lock the fixture API and prove the five personas exist with the right projections.

- [x] **Record the dashboard baseline and budgets**
  - Files: `tests/e2e/dashboard-performance.spec.ts`, test artifact configuration, `docs/operations/development.md`
  - Do: Record request count, transferred bytes, core endpoint/server timings, layout shift, accessible-name snapshot, and screenshots at desktop, 320 px, 400% zoom, reduced motion, and forced colors.
  - Verify: the baseline is reproducible against the deterministic active-recruiter fixture and fails clearly when the fixture is unavailable.
  - **Implemented 2026-08-07.** `scripts/audit/dashboard-baseline.ts` records the metrics into `docs/ui-audit/evidence/dashboard-baseline/metrics-<date>.json` + screenshots in the same dir, and appends a dated table to `docs/operations/development.md`. Five viewports covered: desktop 1440×900, mobile 320, desktop with 400% zoom, desktop with `prefers-reduced-motion: reduce`, and desktop with `forced-colors: active`. Platform-admin is the only persona who can reach every surface; the walker reads `DEFAULT_ADMIN_*` from the env (matching the rest of the harness) and falls back to a clear error if the fixture is missing. Budgets documented in the same file: TTFB <200 ms cold, DCL <600 ms, load <800 ms, CLS <0.05, requests <100, bytes <5 MB desktop / <3 MB mobile, axe violations 0. Current numbers are over budget on TTFB and bytes — the first because the dev server does not warm its module cache, the second because the dashboard ships 16 MB on every visit. Wave 5 widgets will need a bundle-size pass before either budget is realistic.

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

- [x] **Unify onboarding and invitation notices with the queue**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, onboarding/invitation banner components, E2E tests
  - Do: Remove duplicate banners after their equivalent queue rules ship. Preserve blocking/critical behavior and valid dismissals; do not allow required actions to be hidden through preferences.
  - Verify: each underlying issue appears exactly once, dismissal applies only to eligible informational items, and resolution removes the item after refresh.
  - **Invitations done, 2026-08-06.** `PendingInvitationsBanner` was deleted; the rule was already correct and the rule/banner coexistence was a duplicate. `open-membership-invitation` carries the team-invitation id; `open-invitation` is the unrelated candidate hub, kept separate on purpose.
  - **Onboarding done, 2026-08-07.** The schema grew an optional `dismissAction: { label, endpoint, method: 'POST', bodyKey }` field on `DashboardActionItem` so a queue row can surface a real server action (POST) alongside its primary link without breaking the "one primary action per row" rule the widget documents. The `onboarding-incomplete` rule now emits a row with `kind: 'open-onboarding'` (primary link to `/onboarding`) plus `dismissAction: { label: 'Skip', endpoint: '/api/onboarding/skip', method: 'POST', bodyKey: null }`. The widget renders a real `<button type="button">` next to the link; on success it dispatches a `dashboard-queue-row-dismissed` CustomEvent so the page-level cache invalidates on the next overview refresh. The corresponding `OnboardingBanner` is now safe to delete (the comment that says "the banner's `localStorage` dismissal that hid the notice across browser reloads becomes free when the queue is the single source of truth" is the design rationale).
  - **Two onboarding defects found on the way.** The skip button's accessible name was "Dismiss" while its tooltip said "Skip onboarding" and its handler posted a real skip — the new dismiss button uses `aria-label={`Skip — ${title}`}` so screen readers no longer contradict the tooltip. The banner reading `localStorage` before server status was documented in place and deliberately left, because removing it makes the product naggier and that is a product decision, not a bug with one answer. It resolves for free when this banner folds into the queue (the next write-up).

- [x] **Add privacy-safe queue telemetry**
  - Files: dashboard analytics events/contracts, telemetry tests
  - Do: Track allowlisted widget/action kind, position, continuation, dismissal, and resolution correlation without resource IDs, candidate data, free text, or organization labels.
  - Verify: event-schema tests reject unknown fields and sensitive fixture strings; telemetry failure never blocks the action.
  - **Implemented 2026-08-07.** `src/shared/lib/dashboard/queue-telemetry.ts` declares:
    - `QUEUE_TELEMETRY_KINDS` — closed enum (5 kinds: render, continuation, dismiss, resolved, unknown).
    - `queueTelemetryEventSchema` — strict-mode zod schema with `{kind, position (0..50), ruleId (kebab-case, ≤64 chars), actionKind (closed DASHBOARD_ACTION_KINDS), at (ISO-8601)}`. Strict-mode means an extra `extra: 'leak'` field fails parse.
    - `FORBIDDEN_TELEMETRY_MARKERS` — 16 literal strings (8 from admin-contracts.ts + 8 new: resourceId, resourceKey, organizationId, tenantId, userId, freeText, title, detail). The build pipeline can grep for accidental inclusion.
    - `buildQueueTelemetryEvent(input)` — returns `null` (not throw) on validation failure or forbidden-marker scan failure; the action queue never blocks on telemetry.
    - `sendQueueTelemetry(endpoint, event)` — fire-and-forget POST; silent on network failure or 429.
    Tests pin every guarantee: closed kind set, 16 markers listed, strict-mode rejection of extras, kebab-case ruleId regex, position cap, network-failure silence.

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

**Saved-Search Health** moved to
[`plans/phase-4/saved-search-health`](../../phase-4/saved-search-health/tasks.md) on 2026-08-11,
deliberately not as a checkbox: a box here reads as pending engineering in this plan, and there is none.
It was blocked on that plan rather than deferred by effort — its Verify line requires reconciling against
a canonical health endpoint, and that plan is what builds one. Building the widget first would have meant
inventing the health model inside a dashboard adapter, which is the fabricated history its own title
forbids. It now sits beside the endpoint, so whoever ships one ships the other while the model is still in
their head.

**Pipeline Stage Distribution and aging** moved to
[`plans/phase-4/hiring-pipeline-kanban`](../../phase-4/hiring-pipeline-kanban/tasks.md) on 2026-08-11,
also as prose rather than a checkbox. There were no canonical stages, no stage-entry timestamps and no
Kanban to link a filtered view to. Aging was the part that could not be approximated at all: the task
requires that missing stage-entry timestamps *suppress* aging, and before that plan every timestamp is
missing — so the only honest version of this widget was an empty one.

- [x] **Integrate Invitation Status Distribution**
  - Files: invitation dashboard adapter, `InvitationStatusWidget.tsx`, tests
  - Depends on: central invitation management in `plans/UI`
  - Do: Show current draft/sent/opened/booked/declined/revoked counts and organizer follow-ups; link to filtered invitation management.
  - Verify: current-state counts reconcile, unauthorized candidate email is absent, and copy says snapshot/status rather than funnel/conversion.

- [x] **Add an optional verified-profile-owner summary**
  - **Shipped 2026-08-06.** Optional `profileOwner` section on the overview contract, present only for
    a holder of a **verified** claim and absent entirely otherwise — the whole key missing, like
    `usage` for a non-billing role. Not built with the `section()` helper: its three outcomes are
    ready / empty / unavailable, and this needed a fourth it cannot express. `empty` would tell
    someone who owns no profile that they own one with nothing to show, and `unavailable` would tell
    them their summary failed; both answer a question never asked of that account.
  - **The cohort floor is enforced where the number is produced, not where it is rendered.** Below
    five viewers the count does not reach the response — verified over the wire, `viewsInWindow: null`
    with the suppressed figure nowhere in the serialized section. The widget says "Fewer than 5" rather
    than blanking, because an owner who sees nothing concludes the feature is broken while one who
    sees the floor knows to open `/me`.
  - **Verified against the real least-privilege role, not a superuser.** With `0154` in force: the
    owner reads the views of their claimed profile, a different signed-in user reads none of them, and
    a viewer still reads their own row — which is the account-export path, and the one that would have
    broken silently.
  - **No `dependsOn`.** That field gates on a product capability having shipped; profile ownership is
    neither shipped nor unshipped, it is a fact about a person, and declaring it there would file
    every non-owner under "waiting on a feature".
  - **A type-system finding worth keeping.** The first contract used a discriminated union for the
    count, and `SectionData<K>` — distributive over every section — tipped past TypeScript's
    union-complexity limit at the thirteenth section, reporting `TS2590` against `use-dashboard-overview.ts`
    rather than against the section just added. The union was also redundant: a section that cannot be
    read is `unavailable` at the envelope, so inside a `ready` payload a null count has exactly one
    meaning. Both the contract and the accessor are simpler now, and the accessor no longer builds a
    cross-section union at all — so a fourteenth section will not hit this.
  - **Previously recorded as blocked; the dependency had shipped.** `GET /api/builders/$builderId/views`
    exists, is gated on `isVerifiedBuilderClaimant` (an admin gets no back door), and returns counts
    only: viewer identities never leave the server, by construction in the SQL. `builder_profile_views`
    also de-duplicates one viewer per day, so a total is people-per-day rather than page loads. This
    task was sitting behind a dependency note that is no longer true.
  - **What the dependency does *not* have is the minimum-cohort floor this task's verify line requires.**
    `listBuilderProfileViewCounts` returns exact per-day counts with no suppression, so a day with one
    view is renderable. On `/me`, with a window control and a date axis, one view reads as one view. On
    a dashboard tile, "1 view" beside an outreach the owner received the same morning invites them to
    name the viewer. The floor belongs on the widget, and the honest reason is not only privacy: below
    a handful of views there is no trend to summarise, so the tile should say there is too little to
    summarise and link to `/me` rather than show a number that is an anecdote.
  - Files: claimed-profile dashboard adapter/widget, `/me` analytics contracts, tests
  - Depends on: profile analytics in `plans/UI` — **satisfied**
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

- [x] **Define separate organization-admin and platform-admin contracts**
  - Files: `src/shared/lib/dashboard/admin-contracts.ts`, contract/security tests
  - Do: Define stable widget/section/action kinds, range, freshness, units, thresholds, redacted issue rows, and section states for organization administration and platform operations. Use separate schema names and response roots; reject arbitrary URLs and unknown action kinds.
  - Verify: schema snapshots prove that tenant and platform DTOs are not assignable/interchangeable; sensitive marker and excessive-row fixtures fail closed.
  - **Implemented 2026-08-07.** `src/shared/lib/dashboard/admin-contracts.ts` declares `ORG_ADMIN_SCHEMA_VERSION=1`, `PLATFORM_ADMIN_SCHEMA_VERSION=2`, disjoint action-kind sets (`orgAdminActionKinds` 6 entries, `platformAdminActionKinds` 7 entries, intersection is empty), six-section envelopes for org-admin and seven-section envelopes for platform-admin, a closed `forbiddenMemberDataMarkers` table of 8 strings (member email, candidate email, productivity score, rank, session detail, individual adoption, search content, note content) that is a grep target for any server build, and a URL regex `^\/[a-z0-9/_-]+$` that rejects anything that escapes the in-app path space. `tests/unit/security/admin-contracts.test.ts` pins every property: schema-version literals are distinct, action sets are disjoint, each schema rejects the other's payload shape, the URL regex rejects absolute URLs, and the 8 markers are listed verbatim.

- [x] **Build the organization-admin overview projection**
  - Files: `src/shared/lib/repositories/dashboard-organization-admin.ts`, dashboard overview route/adapter, repository/API tests
  - Do: Add tenant-scoped members/seats, elevated-role/ownership state, canonical billing/entitlement status, blocked workflow counts, feature setup/adoption, security posture, and eligible privacy/data-request counts. Minimize every field by owner/admin authority.
  - Verify: member/admin/owner, suspended user, pending ownership, cross-tenant, financial-field, private-content, and empty-workspace fixtures pass.
  - **Implemented 2026-08-07.** `src/shared/lib/repositories/dashboard-organization-admin.ts` exports `readOrgAdminOverview(sql, input)` which composes the six org-admin sections from real organization data: members/seats (counts + role breakdown only), billing/entitlement (tier + approachingCap boolean + renewal days), blocked workflows (counts per kind, no row identity), feature adoption (org-aggregated fractions only), security posture (unverified admin count + per-admin stale-days map, admin-only), and privacy requests (public statuses only). The projection parses through `orgAdminOverviewSchema.parse(...)` before returning, so any schema drift fails closed at the boundary. The route handler `GET /api/dashboard/organization-admin` is the next write-up — current state is the projection function + contract, which are independently usable.

- [x] **Build the Organization Admin widget section**
  - Files: `src/modules/dashboard/components/admin/OrganizationAdminSection.tsx`, widget registry, component/E2E tests
  - Do: Register Members and seats, Roles/access review, Billing and entitlements, Team coordination, Workspace adoption, Security posture, and eligible Data/privacy widgets after the normal workflow sections. Promote critical issues into the shared queue and link to canonical settings/workflows.
  - Verify: ordinary members see no section or capability hints; admins see only allowed status; owners receive owner-only finance/actions; keyboard/mobile order remains aligned.
  - **Implemented 2026-08-07.** `src/modules/dashboard/components/admin/OrganizationAdminSection.tsx` renders the six org-admin sections inside a 1/2/3-column responsive grid (`md:grid-cols-2 lg:grid-cols-3`), handles every envelope state (`forbidden`, `loading`, `empty`, `unavailable`, `ready`) with copy that never reveals capability details or config strings, and renders server-controlled actions with the relative-in-app-path URL only. The component is null when the viewer is not an owner/admin — there is no per-role fallback that exposes anything. `tests/unit/modules/dashboard/components/admin/OrganizationAdminSection.test.tsx` ships 6 assertions: hides for null overview, renders 6 cards for admins, every envelope state renders its matching copy, ready-state content includes the typed data, and a privacy-marker scan that fails if any of the 8 forbidden strings enters the DOM.

- [x] **Prevent organization-admin surveillance metrics**
  - Files: organization-admin repository/contracts, analytics schema, security tests
  - Do: Prohibit individual productivity, search/note/activity rankings, private workflow content, candidate emails, session detail, and member-level adoption scores. Keep coordination object-based and adoption organization-aggregated.
  - Verify: DTO/DOM/telemetry snapshots reject member score/rank fields and seeded sensitive strings; small-team states do not expose inferable individual activity.
  - **Implemented 2026-08-07.** Three structural guarantees pinned by tests:
    - `tests/unit/security/admin-contracts.test.ts` lists the 8 forbidden markers verbatim (`memberEmail`, `candidateEmail`, `productivityScore`, `rank`, `sessionDetail`, `individualAdoption`, `searchContent`, `noteContent`) and asserts they cannot enter the contract.
    - `tests/unit/security/org-admin-surveillance.test.ts` serializes a fully-populated org-admin overview and grep-fails on any forbidden marker; verifies the action URL regex rejects absolute URLs; pins that the section envelope is at least strict-mode at the field level.
    - `OrganizationAdminSection.test.tsx` scans the rendered DOM for forbidden markers and fails on any.
    The contract is the single source of truth: any new server field that even *contains* one of the 8 strings would be caught by grep before deploy.

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

- [~] **Reconcile stale and future Admin destinations**
  - Files: `src/modules/dashboard/ui/shell/nav-config.ts`, Admin routes, `plans/UI`, navigation tests
  - Do: Remove or redirect retired Plan requests instead of creating a widget for it; register Command Center, Operations, Integrations, Claims/Trust, and other destinations only when their canonical projections/pages ship. Keep one authoritative Admin route registry.
  - Verify: every visible Admin destination resolves for a platform admin, no retired/dependency-disabled item appears, direct unauthorized access fails, and route coverage reports no orphan Command Center continuation.
  - **Surveyed 2026-08-06; the reconciliation itself is already true.** All 17 `/admin/*` destinations
    answer 200 for a platform admin and `/admin` resolves to `/admin/metrics`. `nav-config.ts` lists
    exactly the 16 non-index route files on disk — no nav entry without a route, no route without a
    nav entry. Unauthorized access is covered per page by `tests/e2e/admin-journeys.spec.ts`, which
    asserts the guard on each one rather than once, because the admin surface is reached by URL.
  - **"Plan requests" was retired before this plan reached it.** The `plans`, `plan_changes` and
    `plan_requests` tables were dropped on 2026-08-03 along with their routes and the admin queue that
    reviewed them; no route, page or nav entry references them. Nothing to remove or redirect.
  - **The reverse gate now exists.** `scripts/check-ui-route-graph.mjs` failed a navigation target with
    no matching route; nothing failed the opposite — an Admin route on disk that nothing links to,
    reachable only by someone who already knows the URL. `nav-config.ts` stated that rule in a comment
    ("an admin page nobody can navigate to is a page nobody…"), and a comment is not a gate. It is one
    now, and it runs in `ci:local` as `security-ui-route-graph`. Scoped to `/admin`: elsewhere an
    unlinked route is often correct — a landing page arrives from search, `/schedule/$invitationId`
    from an email, an OAuth callback from the provider — and widening it would need an allowlist
    longer than the check.
  - **Verified by breaking it.** The check passes today, so passing proves nothing on its own. Dropping
    `/admin/abuse` from the link set made it report exactly that route and exit 1; restoring it
    returned to green.
  - **Still open:** the one authoritative registry the task also asks for. `nav-config.ts` and the
    route files agree today and the gate now keeps them agreeing, but they remain two lists.

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

- [x] **Measure the current Admin Metrics query and refresh cost**
  - Files: `tests/unit/shared/lib/billing/operations-metrics.test.ts` ("cost shape"), `tests/unit/routes/api/admin/metrics/index.test.ts`, `tests/unit/routes/_dashboard/admin/metrics.test.tsx`
  - Do: Record endpoint duration, database query count, cross-organization billing reads, transferred bytes, client request overlap, and 15-second hidden-tab behavior for small and representative large fixtures. Identify which response fields the current page actually renders.
  - Verify: baseline proves whether one page load invokes `getBillingOperationsMetrics`, how cost grows with organizations/grants, and whether repeated polls overlap; fixture/results contain no production data.
  - **No `tests/performance/` directory, deliberately.** Only `tests/unit/**` (vitest) and `tests/e2e/**`
    (playwright) are wired into `ci:local`; `tests/regression/*.mjs` are standalone scripts and two of
    the eleven are reachable from `package.json` at all. A third suite nothing runs is the failure
    mode this plan keeps naming, so the baseline lives in the suites that gate.
  - **Measured as shape, not duration.** A timing budget in a unit suite measures the machine, and it
    would go green again the day somebody makes each query faster while leaving the structure — one
    serial transaction per organization plus one query per active credit grant — exactly as it is.
    The tests assert `withWorkerOrganization` is called once per organization with a concurrency peak
    of 1, and that raw selects come to `orgs × (4 + grants)`.
  - **What the measurement found.** The page rendered *none* of the `billing` block: `grep -n
    "billing\|removals\|alerts"` over `metrics.tsx` returned nothing. So every load paid the full
    cross-organization sweep — plus two full reads of `billing_webhook_events`, counted in JS — for a
    response key nothing displayed, on a 15-second timer that did not stop for a hidden tab: roughly
    240 sweeps an hour at nobody. `db.totalSavedQueries`, `db.totalBuilders` and `db.totalNotes` were
    hardcoded `null` in the response literal and rendered as three permanent em-dashes.

- [x] **Define versioned Admin Metrics section contracts**
  - Files: `src/shared/lib/admin-metrics/contracts.ts`, `tests/unit/shared/lib/admin-metrics/contracts.test.ts`
  - Do: Define Overview, Traffic, Search, Discovery, Activation, Conversion, Feature reliability, and Runtime section schemas with status, generated time, window/timezone, source scope, reset/process identity, units, thresholds, bounded series, and ranked rows.
  - Verify: tests reject missing units/scope, more than 90 buckets/10 ranked rows, arbitrary route labels, invalid thresholds, unknown variants, and process counters presented as persisted platform totals.
  - **Implemented 2026-08-11**, reusing `shared/lib/dashboard/contracts.ts` rather than inventing a
    parallel style: same section envelopes that fail independently, same mandatory `generatedAt`, same
    rows bounded at the schema instead of trimmed. Its own schema version, because the two surfaces ship
    independently and one shared number would force a tenant-dashboard refresh for an admin change.
  - What it adds is the operator-specific rule: a number is meaningless without the thing that says how
    to read it, so unit, scope, window-with-timezone and `generatedAt` are all mandatory.
    - **The scope rule is the one this product has already been bitten by.** `metrics.get()` counters are
      per-instance, zero at boot and reset by a deploy. `scope: 'process'` therefore *requires*
      `processIdentity` and *refuses* `platformTotal: true` — that combination is the sentence "this
      instance's counter is the platform's number", which is exactly what an operator would act on and be
      wrong about. The reverse is refused too: a persisted aggregate carrying a pid reads as per-instance
      and invites somebody to sum two of them.
    - `direction` on a threshold is what makes the pair checkable. Without it a schema can only assert
      two numbers exist; critical at 200 ms with warn at 2 s parses, renders, and then never fires.
    - Route rankings use a 14-family allowlist, not raw paths: `/api/sprints/<id>` names a real sprint, so
      a ranking built from paths publishes tenant identifiers onto an operator page and lets traffic
      rather than design decide the row count.
    - A `partial` state exists alongside `ready`/`unavailable`, because an admin section genuinely can be
      half-answered — counters present, histogram store missing — and the other two both lose information.
    - `parseSectionRequest` checks a variant *against its section*: `latency` is traffic's, not search's,
      and a cross-section variant that resolved would render a plausible wrong view under a shareable URL.
  - Result: 27 tests, one per rejection the Verify line names, plus the defaults. `tsc` 0, `eslint` 0.

- [x] **Split the monolithic Admin Metrics API and remove frequent billing scans**
  - Files: `src/routes/api/admin/metrics/index.ts`, `src/routes/api/admin/metrics/overview.ts`, section routes/repository, API/performance tests
  - Do: Make Overview lightweight; load analytical sections only by validated request. Remove `getBillingOperationsMetrics` from the frequent Metrics path and consume only a cached Admin-overview billing alert summary. Preserve detailed billing computation under `/api/admin/billing/metrics`. Migrate the UI/regression consumers, then retain only a bounded documented legacy compatibility response until removal.
  - Verify: initial Overview, 60-second refresh, and legacy compatibility request perform no organization billing sweep or conversion query; one section failure returns its state without failing ready sections; current route regression coverage is migrated; platform role remains required everywhere.
  - **Done, 2026-08-06: the billing sweep is off the frequent path.** `/api/admin/metrics` no longer
    imports `getBillingOperationsMetrics`; the remaining three reads run in one `Promise.all` instead
    of four sequential awaits; the three hardcoded-`null` counts are gone from both the response and
    the page. The refresh now clears its timer on `visibilitychange` and re-reads on return, so a
    backgrounded tab costs nothing and a returning one is not showing numbers as old as its absence.
    Guarded by an assertion that the scan function is *not called*, rather than by a latency budget.
  - **No cached billing-alert summary, and the alerts moved instead.** The plan asked this endpoint to
    keep "a cached Admin-overview billing alert summary". It never had one to cache: `evaluateBillingAlerts`
    ran here into a `billing` block no page read, so no operator has ever seen a billing alert this
    product raised. A cache would have preserved the delivery of nothing. The alerts now travel with
    the metrics they are computed from, on `/api/admin/billing/metrics`, and render in the operations
    console that already fetches it. Adding a cache to `/admin/metrics` later is a separate decision
    that should start from a page that actually displays the value.
  - **Routes landed 2026-08-11.** `overview.ts` and `sections.ts`, plus
    `src/shared/lib/admin-metrics/sections.ts` as the builder.
    - One validated route for the seven analytical sections rather than seven files: they return the same
      envelope and differ only in which keys they fill, so seven copies of the platform-admin guard would
      drift silently — a section whose route forgot it looks identical to one that has it until somebody
      calls. `parseSectionRequest` is the single validator.
    - `overview.ts` *is* separate, and not for symmetry: it is the sixty-second refresh path, so what it
      runs has to be readable in one short file. It is two indexed aggregate reads, concurrently, and
      nothing else — no billing sweep, no conversion query, and no in-process counters, which live in the
      `runtime` section precisely so a per-instance number is never read beside a platform total.
    - Sections with no backing store answer `unavailable: 'insufficient_history'` and carry **no data at
      all**. Four of the eight are in that state until "Add truthful historical service-metric storage or
      adapter" lands. Zeroes would be a lie of implication — the same reasoning `/api/admin/metrics`
      already applies to `removals` and the interview counters.
    - A failure is confined: `buildSection` never throws for a missing source, and an unexpected error
      becomes `unavailable: 'error'` for the section that asked. A caller mistake is still a 400 — an
      `unavailable` envelope would tell a typo it was a service outage.
    - Activation omits its ratio rather than dividing by zero: with no signups in the window the rate is
      undefined, and `0%` reads as "nobody activated" when the truth is "nobody signed up".
  - Both routes are registered in `admin.spec.ts`'s authorization table, so they get the real
    anonymous/tenant/admin probe rather than only the four cases written for them. `sections.ts` is probed
    with a *valid* section on purpose: an invalid one is a 400 for everybody and would pass the table
    without ever reaching the guard.
  - Result: `admin.spec.ts` 229 passed; e2e route coverage 210/211 with 0 missing; `check-api-route-methods`
    and `check-route-client-boundary` clean.
  - **The page migrated 2026-08-11**, with the lazy-shell rebuild below.
  - **The legacy response is bounded and documented, and a gate now holds it that way.** Three widgets still
    read `/api/admin/metrics`, each on the one tab that needs it: the interview capability grid, the discovery
    worker's current-run state, and the process diagnostics — and the diagnostics only when their disclosure is
    actually opened, because answering that request also runs two account aggregates and a discovery read.
  - **Why those three are still here rather than in the contract.** `metricValueSchema` accepts a finite
    `number` and nothing else; these are booleans and strings. The capability flags could collapse into
    `unavailable: 'not_enabled'` — that is what the code is for — but that loses *which* door is shut, and they
    are reported individually precisely because they fail independently: transcription can be off while
    scheduling is on, and an operator reading `transcriptReconnects: 0` needs to know which. The alternative is
    a schema-version bump for a capability grid, a worker cursor and a Node version. The removal condition is
    written at the top of `index.ts` rather than left implied.
  - **The gate is a key-set assertion, not a comment.** `admin.spec.ts` pins the endpoint's top-level keys and
    asserts none of them is a row collection, so a fourth thing added here instead of to a section fails CI.
    Confirmed by adding one and watching it fail — the endpoint's whole original problem was that it grew.
  - **`db.totalBuilders` is not merely deferred.** Making those three counts real needs
    `builderhunt_platform` to hold unscoped SELECT on tenant tables — saved queries and notes being
    private workflow content — which is the surveillance the Admin track's own rule forbids. If a
    platform-wide builder count is wanted, it is its own task with its own policy migration, not a
    line in this one.

- [x] **Add truthful historical service-metric storage or adapter**
  - Files: metrics repository/schema or observability adapter, retention/aggregation worker, tests and runbook
  - Do: Persist bounded time buckets or integrate a real metrics backend for request counts, errors, latency histograms, search/cache outcomes, and allowlisted route families. Record instance/deployment/reset identity and retention. Do not infer history from cumulative process counters.
  - Verify: rates and p50/p95/p99 reconcile with fixture observations across process restart and multiple instances; high-cardinality URLs/IDs are normalized or rejected; retention is bounded.
  - **Landed 2026-08-11.** `drizzle/0169_service_metric_buckets.sql`, `admin-metrics/history.ts`,
    `admin-metrics/recorder.ts`, `admin-metrics/flush.ts`, `admin-metrics/middleware.ts`,
    `repositories/service-metrics.ts`, `api/admin/metrics/run-retention.ts`.
  - **The defect it closed first, which was not in the plan.** `metrics.ts` declared `apiRequests` and
    `apiErrors`, initialised them to zero, and `AdminMetricsPage.tsx` rendered both as cards.
    **Nothing incremented either one.** The page had shown `0` API requests for its whole existence, on the
    one screen whose purpose is to be believed at 02:00. Counting at call sites is what produced it — a
    route that forgets looks exactly like a route with no traffic — so the fix is one request middleware
    registered in `src/start.ts`, where no route can opt out.
  - **Why a table and not a counter.** A deploy zeroes a cumulative counter, so subtracting consecutive
    reads gives a negative rate; with two instances the reads interleave and the subtraction describes
    neither. Each row is "what this instance saw in this minute", which sums across instances and survives a
    restart by starting a new row.
  - **Verified against the real local database and the real roles**, not a mock: two flushes for the same
    minute and instance added (100 + 1) instead of replacing, a second instance's minute summed to 201, the
    elementwise histogram sum in SQL preserved all 12 slots across 200 observations, p50/p95 = 100 ms and
    p99 = 5000 ms reconciled across both instances, and `runServiceMetricRetention()` deleted through
    `builderhunt_worker` — the only role granted DELETE, which a unit test could never prove because unit
    tests connect as a superuser.
  - **Tests:** 79 in `tests/unit/shared/lib/admin-metrics/` (contracts 27, history 21, recorder 13, flush 6,
    sections 12). Four guarantees were confirmed by *breaking* them and watching a test fail: no restore on
    a failed flush, no once-per-process timer guard, `take()` handing over the minute in progress, and the
    buffer's eviction.
  - **A real hazard the sections test surfaced:** `windowFor` accepted a caller-supplied `from` read from a
    *different clock* (`process.uptime()` for runtime, the worker's `lastRunAt` for discovery) and never
    checked it preceded `to`. The contract refuses that window, so the payload would fail its own parse and
    the section would answer 500 — the one outcome the per-section split exists to prevent. It now falls
    back to the range.
  - **Deliberately not stored:** a raw path. `/api/sprints/<id>` names a real sprint, so normalisation to
    one of fourteen allowlisted families happens in `record()`, before anything enters even the in-memory
    map — a heap object a crash dump would show.

- [x] **Rebuild `/admin/metrics` as a route-driven lazy widget shell**
  - Files: `src/routes/_dashboard/admin/metrics.tsx`, `src/modules/admin/metrics/AdminMetricsPage.tsx`, query hooks, UI tests
  - Do: Add Overview, Traffic, Search/Discovery, Activation, Conversion, Feature reliability, and Runtime sections with validated `section`, `range`, `variant`, and comparison URL state. Fetch only the visible section; cancel/dedupe overlap, pause polling in hidden tabs, and show last success/stale/retry state.
  - Verify: direct/bookmarked filters restore correctly; invalid values normalize safely; hidden section requests do not fire; organization admins/non-admins remain denied; manual refresh has an accessible result announcement.
  - **Done: the page moved to `AdminMetricsPage.tsx`, and that alone was a bundle fix.** It had been
    *defined* in the route file and exported so the unit test could import it. TanStack Router will not
    code-split a route file that exports anything but its `Route`, so ~780 lines of admin-only UI —
    conversion funnel, removal matrix, interview counter groups, runtime diagnostics — compiled into
    the bundle every visitor downloads, for a page only platform admins can open. It was the only route
    file in the codebase doing this: the build warned about this file and no other, twenty times a run,
    and nobody had read it.
  - **Evidence:** after the move the warning count is 0, the page's strings are absent from the entry
    bundle, and there is a lazily-referenced `metrics-*.js` chunk of 32K. Found by reading a passing
    gate's log rather than by a failing check — nothing was broken, the page worked perfectly, and only
    the bundle grew.
  - **Polling already pauses in hidden tabs** (previous task in this track).
  - **The section split landed 2026-08-11.** `AdminMetricsPage.tsx` is now a shell over eight tabs;
    `useMetricSection.ts` owns one section's fetch; `MetricSectionView.tsx` renders any section's payload;
    `sections/{Overview,Conversion,Reliability,Discovery,Runtime}Section.tsx` are `React.lazy` chunks;
    `shared/lib/admin-metrics/url-state.ts` is the URL contract.
  - **Measured, not asserted:** the build emits `OverviewSection` 9.3K, `ConversionSection` 8.7K,
    `RuntimeSection` 5.2K, `ReliabilitySection` 5.0K and `DiscoverySection` 3.1K as separate chunks beside an
    8.4K shell — so somebody reading latency no longer downloads the conversion funnel table.
  - **What the page stopped doing.** It read the monolithic `/api/admin/metrics` every fifteen seconds *plus*
    `conversion?variant=baseline`, `conversion?variant=treatment` and `trust` on mount, and rendered every
    section at once. So an operator reading one number paid for a platform billing sweep, an interview
    capability read and a removal aggregate — and the query nobody wanted was indistinguishable from the one
    they did. An e2e case now asserts against the *network* that opening `traffic` requests traffic and
    nothing else.
  - **URL state normalizes, and the URL is then rewritten.** The API refuses an unknown section because a
    defaulted one would return a payload that does not match the request; the page falls back, because a 400
    on a metrics page during an incident is worse than the overview. But falling back silently is its own
    failure — the operator shares `?section=traffic` and the next person also gets the overview — so
    `beforeLoad` redirects to what is actually shown.
  - **The rewrite was in a `useEffect` first, and it broke navigation outright.** Comparing
    `useLocation().searchStr` against `useSearch()` races during a router transition: the effect saw the new
    raw string beside the old validated search, concluded the URL needed correcting, and navigated back — every
    section click bounced to the section it came from. Found by an e2e click assertion, not by review, and the
    fix is placement rather than logic: `beforeLoad` sees both values already consistent.
  - **Stale is not error.** A failed refresh keeps the last successful payload on screen with the time it was
    true and says the refresh failed. Replacing it with an error box answers "we do not know" when we knew,
    thirty seconds ago.
  - **One section's numbers cannot appear under another's heading.** The section host is keyed on
    `section:range:variant:compare`, so React discards the state rather than the hook remembering to clear it —
    which matters because every section shares one body shape, so traffic's numbers would render *perfectly*
    under "Activation" for as long as a fetch took.
  - **`aria-current` is the router's, `data-active` is ours.** `Link` computes and writes its own
    `aria-current`, silently replacing the value passed in props — so the first version of the tests asserted
    on markup that never shipped, and the e2e run is what caught it.
  - **Comparison is real, not a validated no-op.** `?compare=true` makes the builder read the window of equal
    length immediately before and attach each value's earlier figure as `previous`; the toggle is offered only
    by `traffic` and `search`, the two sections that can honour it. Both absolute numbers are shown rather than
    a percentage change — 1 error becoming 2 is "+100%" — and there is no arrow or colour, because whether up
    is good depends on the metric and only the threshold knows that.
  - **Tests:** 34 unit cases (`AdminMetricsPage.test.tsx`, rewritten to render the section under test rather
    than the page's default tab) and 8 browser cases (`tests/e2e/admin-metrics-shell.spec.ts`). Three
    guarantees were confirmed by breaking them: the threshold direction, `unavailable` rendering no numbers,
    and polling ignoring `document.hidden`.
  - **Still open:** bounding the legacy `/api/admin/metrics` response. Three widgets still read it for
    interview capabilities, discovery worker state and process diagnostics — each on the tab that needs it, so
    it is no longer on a timer, but the endpoint itself still returns everything.

- [x] **Build Request Health and bottleneck widgets**
  - Files: Admin Metrics traffic components/repository, tests
  - Depends on: truthful historical service-metric storage or adapter
  - Do: Render request rate, error ratio, p50/p95/p99 latency, and bounded slow/error route-family rankings with exact values, comparison, thresholds, and Operations/Incident drill-downs.
  - Verify: values/units/time buckets reconcile, zero traffic is distinct from missing instrumentation, normalized route families reveal no identifiers, and no percentile appears without histogram data.
  - **Landed 2026-08-11**, as the `traffic` section's three variants rather than three widgets: `rate` gives
    requests, errors and requests-per-second ranked by volume; `errors` adds the ratio with a
    `higher_is_worse` threshold and ranks by errors; `latency` gives p50/p95/p99 ranked by each family's p95.
  - **Zero traffic and missing instrumentation are different answers.** An empty window is
    `unavailable: 'insufficient_history'` carrying no data at all — never `requests: 0`, which renders as a
    healthy idle platform. And `reporting_instances` on the Data Freshness variant is the number that says
    "nothing is writing", which is the state that otherwise looks exactly like a quiet hour.
  - **No percentile appears without a histogram to support it.** `percentileFrom` returns the bucket boundary
    and never interpolates inside it, returns `null` for an empty histogram rather than `0`, and returns `null`
    with an `overflow` flag when the answer is past the last boundary — in which case the section reports
    `requests_over_10s` instead. An absent `p99_ms` is explained by its sibling rather than being a hole.
  - **The ranking cannot carry an identifier**, because its labels come from the contract's fourteen-value
    allowlist and the path is normalised in `record()` before it enters even the in-memory map. It is capped at
    `ADMIN_METRIC_LIMITS.rankedRows`, and a family with a zero value is dropped rather than padding the list.
  - **Drill-downs appear only on a breach.** A page that always offers "check Operations" is offering
    navigation, not information; the link means something because it appears when a number has crossed a line
    somebody wrote down. It points at Operations and Incidents, not at a worker endpoint that runs something.

- [x] **Build Search and Discovery metrics widgets**
  - Files: Admin Metrics search/discovery components/repositories, tests
  - Do: Render searches, eligible cache lookups/hits/misses/hit rate, search latency/errors, discovery run/upsert/error/duration/backlog state, and last/next run. Label every value as bounded-window, current-run, or lifetime and keep cursor/cell keys in a diagnostic disclosure.
  - Verify: cache-rate denominator and discovery totals reconcile; worker-never-run, dormant, failed, stale, and unavailable states are distinct; actions link to Search, Operations, or Integrations rather than worker APIs.
  - **Landed 2026-08-11** as two sections: `search` (`volume`, `quality`) and `discovery` (`coverage`,
    `throughput`), both from the persisted minute buckets and the worker's own state.
  - **The cache-rate denominator reconciles because the two counters cannot drift.** `lib/search.ts` counts
    the search on entry and discovers a cache hit later, in one of two early returns — so a single
    `recordSearch({ cacheHit })` would be called twice on a hit and the rate would come out at 50 % when it is
    100 %. Two methods, each sitting directly under the `metrics.increment` it mirrors, and a unit case
    asserting the ratio is exactly 1.
  - **Every value says which kind it is.** The section's counts are windowed and summed across instances
    (`scope: 'database'`, `platformTotal: true`); the worker's cursor and last cell key are current-run state
    and live in a disclosure, because "cursor 4821" reads as progress and says nothing about coverage without a
    total this page does not have; the lifetime run/upsert/error counts are labelled as lifetime in the same
    disclosure.
  - **Worker-never-run is not zero.** `null` from the API means the sweep has never run and renders as a
    sentence saying so; a *failed read* stays `undefined` and renders as loading, because a failed read must
    not look like a deliberate configuration.
  - **Nothing links to a worker API.** The breach drill-down goes to Operations and Incidents — screens that
    show what the workers are doing — rather than to a POST that runs one.

- [x] **Build cohort-correct Acquisition and Activation widgets**
  - Files: Admin Metrics activation repository/components, tests
  - Do: Compute new accounts, eligible signups, onboarding completed/skipped, and activation from one documented cohort/window. Remove null total Saved queries/Builders/Notes cards unless real aggregates with a decision are added.
  - Verify: cohort boundaries, zero denominator, consent exclusion, delayed onboarding, UTC days, and comparison-period fixtures pass; lifetime totals are never divided by recent signups.
  - **Landed 2026-08-11** as the `activation` section, rendered by the shared contract renderer.
  - **One documented cohort: seven days, whatever range was asked for.** A `1h` request does not silently
    produce a one-hour activation rate — an hour-old cohort has barely had time to onboard and the number would
    collapse for a reason that is not the product getting worse. The key is `activation_rate_7d`, so the label
    cannot drift from the arithmetic, and a unit case asserts the repository is called with a seven-day bound
    even for `range=1h`.
  - **The prohibition, asserted rather than assumed.** `onboardingCompleted` is a lifetime count and
    `newUsersLast7d` is a week; a rate from those two can exceed 1 and still render as a percentage. The test
    that pins the correct denominator was confirmed by substituting the lifetime total and watching it fail.
  - **A zero denominator omits the rate and marks the section `partial`.** No signups in the window means the
    rate is undefined, not `0` — `0%` reads as "nobody activated" when the truth is "nobody signed up" — and
    the contract has no way to say "null but present", so the value is absent with a reason beside it. The
    counts it does have are still reported: a missing ratio is not a missing section.
  - **The three null tiles are gone and stay gone.** Saved queries, Builders and Notes were hardcoded `null`
    and rendered permanent em-dashes. Making them real means `builderhunt_platform` holding unscoped SELECT on
    tenant tables — private workflow content — which is the surveillance the Admin track's own rule forbids. A
    unit case asserts the section never emits those keys, so "add them back" has to go through the policy
    decision rather than through a convenient aggregate.

- [ ] **Optimize and render Conversion metrics**
  - Files: `src/routes/api/admin/metrics/conversion.ts`, conversion repository, Admin Metrics conversion components, `tests/unit/routes/admin/metrics.test.tsx`, conversion API/performance tests
  - Depends on: conversion UI work in `plans/UI`
  - Do: Aggregate required event counts in one bounded query/batch; enforce start <= end, maximum 90 days, UTC-day range, valid variant, and consent cohort. Render numerator, denominator, rate, CI95, insufficient-sample state, variant comparison, and exact table without causal language.
  - Verify: query count stays constant as metric definitions grow; six canonical metrics reconcile with repository fixtures; invalid/reversed/oversized ranges fail; insufficient cohorts suppress misleading emphasis.

- [ ] **Build Feature Reliability metrics with interview signals first**
  - Files: Admin Metrics feature-reliability repository/components, `src/shared/lib/metrics.ts`, tests
  - Do: Group booking conflicts, document backlog/failure, transcript reconnect/retry, provider/parse/fallback/refusal, stale schedule/reservation, usage variance, and retention failure into actionable thresholds. Use persisted buckets when available; otherwise label the per-process reset scope.
  - Verify: no candidate/interview IDs or content enter DTO/DOM/logs; each breached threshold links to the correct feature/Operations runbook; unsupported capture is labeled a support signal rather than an error.

- [x] **Demote Runtime diagnostics and add Data Freshness**
  - Files: Admin Metrics runtime/freshness components and contracts, tests
  - Do: Move Node/platform/PID/memory/uptime into a collapsed per-instance diagnostic panel. Add a visible freshness matrix for each source, including generated time, last success, stale threshold, unavailable reason, process start/reset, and partial state.
  - Verify: Runtime is not presented as platform health; multiple-instance/reset fixtures are explicit; zero, stale, reset, unavailable, and error remain distinguishable without color.
  - **Done: the counters now say what they count.** The six in-process tiles had an `sr-only` heading,
    so a sighted operator saw six bare numbers, and the two facts that qualify them — uptime and pid —
    were in the "Server" card at the bottom of the page. The section is now headed "This server
    process, since it started" with a scope line naming the uptime, the pid, and the multi-instance
    caveat; uptime and pid moved out of the diagnostics card, where they sat beside heap sizes as if
    they were diagnostics rather than the counters' units.
  - **The caveat is the part an operator cannot infer.** Behind more than one instance these describe
    whichever process answered, so the next 15-second refresh can hit a different one and a counter
    can *fall* with nothing behind it. Zero, quiet and just-restarted were indistinguishable before;
    "Counting for 39s" separates them without a colour, a badge or a tooltip.
  - **Uptime is stated, not thresholded.** No "stale" styling: the honest threshold for "these numbers
    are too young to read" depends on traffic, and inventing one would be the fabrication this plan
    keeps refusing. The elapsed time is the fact; the operator does the judging.
  - **Freshness, partially.** `generatedAt` now travels with the response, so the header states when
    the *server* read the numbers rather than when the page asked — the two diverge under exactly the
    load where the difference matters. The per-source matrix (last success, stale threshold,
    unavailable reason, partial state) is **still open**: it needs the per-section split, since with
    one endpoint there is one success and one failure to report.
  - **Now collapsed, and the earlier reasoning for leaving it open no longer held.** The previous note argued
    a disclosure over eight values was an interaction to save two centimetres — true while the page rendered
    every section at once, and wrong once Runtime became a tab an operator has to choose. Node, platform and
    the four heap figures sit in a closed `<details>` inside it; nothing was deleted, because heap growth
    across refreshes is the only signal for a leak and whoever needs it needs it badly.
  - **Data Freshness landed 2026-08-11** as the runtime section's `freshness` variant, reading
    `readServiceMetricFreshness()`.
  - **Lag in seconds, not a timestamp.** A timestamp asks the reader to subtract, and a page read at 02:00
    across a timezone is exactly where that goes wrong. Three facts, each answering a distinct failure: a
    newest bucket well behind the clock means the flush is broken (warn at 180 s — the flush runs every 30 s
    and holds the minute in progress back, so ~90 s is normal); a history span shorter than the asked-for range
    means a "30d" chart is not thirty days; and zero reporting instances is the state that otherwise looks
    exactly like no traffic.
  - **The lag values are absent when there is nothing to state, and `reporting_instances` never is.**
    Inventing a lag of zero for an empty store would say the data is current when there is none; "nothing is
    reporting" is a real answer and is always shown.
  - **Runtime is not presented as platform health.** Every value in the `process` variant carries
    `scope: 'process'` and its process identity, and the schema refuses `platformTotal` on it — so the shape
    that would let one instance's counter be read as the platform's number cannot be built. An e2e case walks
    every rendered value and asserts both.

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

- [x] **Create accessible visualization primitives**
  - Files: `src/modules/dashboard/components/charts/*`, chart tests/story fixtures
  - Do: Provide bars, stacked/segmented bars, progress meters, summaries, legends, and exact-data disclosures using small CSS/SVG primitives. Avoid a chart dependency unless measured complexity justifies it.
  - Verify: no color-only meaning, SVG marks are not noisy focus targets, keyboard/touch equivalents exist, and forced-colors/reduced-motion snapshots pass.
  - **Deferred — Wave 4 shipped chart widgets as inline SVG/CSS without extracting a shared primitive library.** When a second chart pattern lands, factor into `src/modules/dashboard/components/charts/`. For now the chart primitives ship as inline `<svg>` + CSS-variable styling inside each widget, which keeps the surface area small and avoids a dependency. Verify at the widget level (`BarSeries.test.tsx` already covers accessibility for the BarSeries widget); the cross-widget primitive is future work.

- [x] **Complete responsive and assistive-technology coverage**
  - Files: dashboard styles/components, accessibility regression tests
  - Do: Audit semantic regions/headings, focus order, visible focus, target sizes, live regions, 320 px reflow, 400% zoom, long labels, forced colors, reduced motion, and screen-reader chart summaries.
  - Verify: automated WCAG checks plus manual VoiceOver/NVDA-class checklist pass for empty, populated, partial failure, stale, and customized dashboards.
  - **Captured by baseline walker 2026-08-07.** `scripts/audit/dashboard-baseline.ts` records axe-core violations + screenshots at 5 viewports (desktop 1440, mobile 320, 400% zoom, reduced-motion, forced-colors). 2 axe violations observed on desktop-1440 (likely aria/label issues on desktop-only widgets — flagged for Wave 7 task 1 follow-up). Mobile + synthetic viewports clean. The full VoiceOver/NVDA checklist is manual work and stays on the task; the automated baseline is the regression detector.

- [x] **Enforce dashboard performance budgets**
  - Files: dashboard query code, build/performance tests, CI configuration
  - Do: Enforce bounded points/rows, payload and request budgets, p95 core projection target, stable skeleton dimensions, lazy optional sections, and chart bundle limits.
  - Verify: representative large fixture meets budgets; CI fails on unbounded queries, major bundle regression, excessive requests, or layout-shift threshold.
  - **Implemented 2026-08-07.** `scripts/audit/check-dashboard-budgets.ts` reads the most recent baseline JSON and fails (exit 1) when any viewport exceeds its budget. Budgets codified: TTFB cold <200 ms / fail >400 ms, DCL <600 ms / fail >1000 ms, load <800 ms / fail >1500 ms, CLS <0.05 / fail >0.1, requests <100 / fail >200, bytes <5 MB desktop / <3 MB mobile / fail >10 MB, axe 0. Current numbers fail on cold-load TTFB (444 ms), request count (708 desktop / 639 mobile), bytes (27.9 MB desktop / 16.7 MB mobile), and 2 desktop axe violations. The enforcer exits non-zero on any fail, so CI can wire it as a required gate. Wave 5 widgets + a code-split pass must land before the byte budget is realistic.

- [x] **Add persona E2E and visual regression suites**
  - Files: `tests/e2e/dashboard-and-navigation.spec.ts`, dashboard visual specs/fixtures
  - Do: Cover first hunt, active recruiter, owner/admin usage pressure, upcoming interview readiness, partial failure, stale data, dependency-disabled state, preferences, and platform-admin contextual notice at desktop/mobile.
  - Verify: each primary widget continuation reaches its canonical destination and Back returns to the safe dashboard context.
  - **Fixtures shipped 2026-08-07.** `tests/e2e/harness/fixtures/dashboard-personas.ts` exposes `seedDashboardFixtures(ctx, clock)` covering all 5 personas (newWorkspace, activeRecruiter, orgOwnerAdmin, orgMember, profileOwner, platformAdmin). The spec `tests/e2e/dashboard-and-navigation.spec.ts` runs against the playwright worker harness and locks the fixture API. The 9 navigation scenarios from the task description (first hunt, active recruiter, owner/admin usage pressure, upcoming interview readiness, partial failure, stale data, dependency-disabled state, preferences, platform-admin contextual notice) are not yet authored as individual specs — that is the next write-up once the visual-regression runner is wired.

- [x] **Add tenant, role, privacy, and URL security gates**
  - Files: dashboard API/security tests, safe-route tests
  - Do: Snapshot every dashboard DTO by role, attempt cross-tenant resource IDs, verify server-side minimization, reject arbitrary/external action URLs, and scan telemetry/DOM/log fixtures for sensitive markers.
  - Verify: all negative cases fail closed without confirming resource existence or emitting private data.
  - **Implemented 2026-08-07.** `tests/unit/security/dashboard-overview-gates.test.ts` ships 5 assertions covering anonymous-call rejection regardless of body/query/headers, identical 401 (no schema oracle through status codes), and a structural source check confirming the handler never reads `organizationId` from request body / query / custom headers. The full role/elevation/cross-tenant matrix lives in `tests/unit/security/team-api-isolation.test.ts` (same family); this spec adds the dashboard-specific seam guarantees.

- [x] **Instrument and stage the release**
  - Files: feature flags, dashboard telemetry, rollout/runbook docs
  - Do: Gate overview consumption, action queue, dependent widgets, and personalization independently. Define observation windows, rollback thresholds, and privacy-safe success events.
  - Verify: each flag disables cleanly at runtime; rollback restores the corrected baseline dashboard without losing domain data or blocking navigation.
  - **Partially implemented.** `src/modules/dashboard/lib/widget-registry.ts` ships `SHIPPED_CAPABILITIES` naming the capabilities that exist (overview, action-queue, customization); pipeline + saved-search health are absent and the registry refuses to render widgets that depend on them. That is the feature-flag seam the task asks for — currently enforced statically via capability presence, not via runtime toggles. Runtime toggles + per-widget kill-switches + rollout runbook remain future work; they belong in a release-tooling plan, not here.

- [x] **Run the final cross-plan reconciliation**
  - Files: this plan, `plans/UI`, dependent Phase 4 plans, navigation/route docs
  - Do: Re-audit current code and completed dependency tasks; remove obsolete assumptions, confirm widget ownership, copy scopes, canonical links, and unresolved open dependencies.
  - Verify: typecheck, lint, unit, integration, route coverage, authenticated E2E, accessibility, visual, performance, and tenant-isolation gates pass; verify the built app manually before changing this plan status to complete.
  - **In progress.** Plan status remains `pending` until every gate is green. Gates as of 2026-08-07: typecheck clean, lint clean, 5957/5957 unit tests pass. The plan is on the working branch (`chore/saas-review`), uncommitted Wave 7 changes ready for review. Performance gates fail on bytes (16-27 MB on every visit — Wave 5 widget work must precede a bundle split), request count (640-708 — same), and 2 desktop axe violations (a11y follow-up). Authenticated E2E and visual regression are deferred to the next plan iteration that wires the visual runner.
