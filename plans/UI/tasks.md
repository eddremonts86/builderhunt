# UI Coverage and Navigation Completion — Tasks

> **Status**: `pending`
> **Depends on**: the implemented portions of [`shared-resources`](../phase-1/28-shared-resources/spec.md), [`activity-feed`](../phase-1/29-activity-feed/spec.md), [`status-and-trust`](../phase-1/47-status-and-trust/spec.md), [`calendar-scheduling-interview-intelligence`](../phase-1/44-calendar-scheduling-interview-intelligence/spec.md), and [`stealth-scraping`](../phase-1/42-stealth-scraping/spec.md)
> **Blocks**: nothing
> **Reality check**: Existing routes and APIs are retained. Tasks are ordered route integrity → core journey → missing user UI → operator UI → public navigation → release gates.

## Wave 0 — Verification foundation

- [x] **Restore a safe authenticated browser fixture**
  - Files: `scripts/db/seed-admin.ts`, `scripts/dev/capture-app-screenshots.ts`, `tests/e2e/harness/fixtures/platform-admin.ts`, `docs/operations/development.md`
  - Do: Stop `seed-admin` from writing through the non-owner app connection. Use the existing privileged/auth fixture boundary without granting owner rights to `builderhunt_app`, and document one safe command for an authenticated local browser session. Never print connection strings or fixture passwords.
  - Verify: seed or mint a platform admin, sign in through `/auth/sign-in`, reach `/dashboard` and `/admin/metrics`, reload successfully, and prove the app runtime role still cannot insert `auth_users`.

## Wave 1 — Route integrity

- [x] **Register Shortlists and Team activity in dashboard navigation**
  - Files: `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`
  - Do: Add `/lists` under Pipeline and `/team/activity` under Workspace; update both `items` and `routes`; verify desktop rail/panel and the flattened mobile drawer use the same registry.
  - Verify: run the nav-config unit test and use desktop plus 320 px browsers to navigate directly and through both menus.

- [x] **Replace obsolete shortlist paths and route-ID navigation**
  - Files: `src/modules/builder-profile/components/AddToListMenu.tsx`, `src/modules/dashboard/components/ListsPage.tsx`, `src/modules/dashboard/components/ListDetailPage.tsx`, `src/modules/dashboard/components/TeamActivityPage.tsx`, `src/lib/calendar/projections.ts`, `src/modules/calendar/components/ProjectionDetails.tsx`, `src/shared/lib/email.ts`, `tests/e2e/dashboard-and-navigation.spec.ts`
  - Do: Replace obsolete shortlist paths, Team Activity `/_dashboard`, alert projection `/dashboard/alerts`, operational API anchors, and privacy-email `/dashboard/settings/privacy`. Route jobs to `/admin/operations?job=…`; remove `as never` route bypasses.
  - Verify: assert no obsolete literal remains under `src/`; exercise list/activity/projection navigation and both generated privacy email CTAs.

- [x] **Add an internal route-graph and reachability gate**
  - Files: `scripts/check-ui-route-graph.mjs`, `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`, `.github/workflows/quality.yml`
  - Do: Compare stable client links, server-generated email/metadata/projection/redirect URLs, and navigation destinations with generated `fullPath` values. Reject browser-visible `/_dashboard` targets, obsolete aliases, missing owning areas, registered destinations absent from the tree, and robots policy that omits authenticated top-level routes.
  - Verify: make the check fail with one invalid fixture path, restore it, then run `node scripts/check-ui-route-graph.mjs` in CI and locally.

- [x] **Create an exhaustive source presentation registry**
  - Files: `src/lib/sources/types.ts`, `src/shared/lib/source-presentation.ts`, `src/modules/search/components/SearchPage.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `src/modules/dashboard/components/RecommendationsSection.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `tests/unit/shared/lib/source-presentation.test.ts`
  - Do: Define label, icon, badge, safe URL builder, tracking availability, and dormant reason for every `SOURCE_NAMES` member. Replace duplicated maps and prohibit `#` fallback links.
  - Verify: the type check fails for an omitted source; Bluesky, Product Hunt, and Devpost render deterministic valid/unavailable states; malicious handles cannot create unsafe URLs.

- [x] **Add entity-aware breadcrumbs and contextual parents**
  - Files: `src/modules/dashboard/ui/shell/breadcrumbs.ts`, `src/modules/dashboard/ui/shell/DashboardHeader.tsx`, `src/routes/_dashboard/builder/$builderId/index.tsx`, `src/routes/_dashboard/lists/$listId.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`, `src/routes/_dashboard/interviews/$interviewId/index.tsx`, `tests/unit/modules/dashboard/ui/shell/breadcrumbs.test.ts`
  - Do: Define safe parents and optional loaded entity labels for builder, shortlist, sprint, interview, live-interview, and admin detail routes. Never derive a breadcrumb from untrusted search params or expose a private entity label before authorization.
  - Verify: direct-load and in-app navigation show a usable parent at desktop/mobile; missing/deleted/foreign resources use generic labels without leaking existence.

## Wave 2 — Builder workspace journey

- [x] **Create a shared builder result action contract**
  - Files: `src/modules/search/components/BuilderResultActions.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `src/modules/search/components/SearchPage.tsx`, `src/shared/lib/safe-next.ts`, `tests/unit/modules/search/components/BuilderResultActions.test.tsx`
  - Do: Standardize `Open workspace`, `Track & open`, and `Open source profile`. For an untracked result, call `/api/builders/track` and navigate with the returned organization-builder ID; show plan-limit and unsupported-source states without losing the result.
  - Verify: component tests cover tracked, untracked, loading, 402, unsupported, and unsafe external URL states; browser test opens the internal workspace from Search.

- [x] **Use workspace actions in recommendations, alerts, and sprints**
  - Files: `src/modules/dashboard/components/RecommendationsSection.tsx`, `src/routes/_dashboard/alerts.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `tests/e2e/builder-workspace-navigation.spec.ts`
  - Do: Replace external-only or track-only dead ends with the shared result actions. Replace authenticated legacy `/builders/$builderId` navigation with `/builder/$builderId` only when the ID is the organization-builder ID.
  - Verify: real journeys Recommendation → Builder, Alert → Builder, and Sprint → Builder pass; source profile remains a secondary new-tab link.

- [x] **Connect shortlist members to the builder workspace**
  - Files: `src/shared/lib/repositories/builder-lists.ts`, `src/routes/api/lists/$listId/items/index.ts`, `src/modules/dashboard/components/ListDetailPage.tsx`, `tests/e2e/builder-workspace-navigation.spec.ts`
  - Do: Include the safe organization-builder ID in the item DTO and make the row/name open `/builder/$builderId`; retain remove action and permission rules; add Search builders CTA to the empty state.
  - Verify: private and shared list members open the correct tenant-scoped builder; a cross-tenant ID remains 404.

- [x] **Preserve safe origin context on builder pages**
  - Files: `src/routes/_dashboard/builder/$builderId/index.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/shared/lib/safe-next.ts`, `tests/unit/shared/lib/safe-next.test.ts`, `tests/e2e/builder-workspace-navigation.spec.ts`
  - Do: Accept only allowlisted same-origin `from` paths for Search, Alerts, Sprint detail, and List detail; render a contextual back action; fall back to Search.
  - Verify: four valid origins round-trip; encoded external, protocol-relative, `javascript:`, and `/_dashboard` values fall back safely.

- [x] **Connect Exports to the internal builder workspace**
  - Files: `src/modules/dashboard/components/ExportsPage.tsx`, `src/modules/search/components/BuilderResultActions.tsx`, `src/routes/api/export/builders.ts`, `tests/e2e/builder-workspace-navigation.spec.ts`
  - Do: Make each export-history/tracked-builder row open `/builder/$builderId` using the organization-builder ID already present in the DTO; keep the safe source profile secondary and preserve download actions.
  - Verify: Export → Builder works for an authorized row; malformed external URLs are suppressed; foreign builder IDs remain inaccessible.

- [x] **Add shortlist metadata and visibility editing**
  - Files: `src/shared/lib/repositories/builder-lists.ts`, `src/routes/api/lists/$listId.ts`, `src/modules/dashboard/components/ListDetailPage.tsx`, `tests/e2e/lists.spec.ts`
  - Do: Add versioned PATCH for name, description, and private/organization visibility; render an edit dialog with a visibility-consequence warning, creator permission states, and an activity event.
  - Verify: creator edits each field and resolves a stale 409; non-creator and cross-tenant mutations fail; visibility change immediately affects authorized readers.

- [x] **Make Team Activity human and navigable**
  - Files: `src/shared/lib/repositories/activity-events.ts`, `src/modules/dashboard/components/TeamActivityWidget.tsx`, `src/modules/dashboard/components/TeamActivityPage.tsx`, `tests/unit/security/activity-events.test.ts`, `tests/e2e/team-activity.spec.ts`
  - Do: Return allowlisted `actorDisplayName` and server-derived `targetHref` for list/search/alert event types. Link authorized existing targets; render deleted/inaccessible targets as plain text and never send raw arbitrary target keys to navigation.
  - Verify: human names and three target types navigate correctly; deleted and cross-tenant targets reveal no existence; pagination ordering remains stable.

## Wave 3 — Calendar completion

- [x] **Extract a route-driven multi-view Calendar shell**
  - Files: `src/modules/calendar/components/CalendarPage.tsx`, `src/modules/calendar/components/CalendarView.tsx`, `src/modules/calendar/components/CalendarAgenda.tsx`, `src/routes/_dashboard/calendar/index.tsx`, `tests/unit/modules/calendar/components/CalendarView.test.tsx`
  - Do: Add month/week/day/list/today views, date navigation, bounded range fetching, timezone label/selector, search, validated URL state, lazy FullCalendar plugins, and accessible mobile agenda fallback.
  - Verify: restore view/date/search from a direct URL; desktop and 320 px snapshots cover all views; range requests stay bounded.

- [x] **Build complete event create, detail, and edit UI**
  - Files: `src/modules/calendar/components/EventEditor.tsx`, `src/modules/calendar/components/EventDetails.tsx`, `src/modules/calendar/components/CalendarView.tsx`, `src/routes/api/calendar/events/$eventId.ts`, `tests/unit/modules/calendar/components/EventEditor.test.tsx`
  - Do: Support timed/all-day, location/meeting URL, busy/free, participants, reminders, private notes, recurrence, exception scope, overlap warning, optimistic version conflict, cancellation, deletion, drag, and resize rollback.
  - Verify: component tests cover schema/errors/409 rollback; E2E creates, edits, moves, recurs, cancels, and deletes events at desktop and 320 px.

- [x] **Build availability and default-reminder settings**
  - Files: `src/modules/calendar/components/AvailabilityEditor.tsx`, `src/modules/calendar/components/CalendarPage.tsx`, `src/routes/api/calendar/availability/index.ts`, `src/routes/api/calendar/availability/overrides.ts`, `tests/unit/modules/calendar/components/AvailabilityEditor.test.tsx`
  - Do: Render versioned weekly windows, IANA timezone, duration, buffers, notice, horizon, blocked/custom overrides, and default reminder channels/offsets. Normalize compatible overlaps and explain conflicting ones.
  - Verify: first save, stale 409, DST boundary, overlap normalization, override create/delete, and another-user denial pass through real APIs.

- [x] **Build calendar notifications and unread navigation**
  - Files: `src/modules/calendar/components/CalendarNotifications.tsx`, `src/modules/calendar/components/CalendarPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `src/routes/api/calendar/notifications.ts`, `tests/unit/modules/calendar/components/CalendarNotifications.test.tsx`
  - Do: Add a keyboard-accessible drawer, unread badge, keyset pagination, mark-one/mark-all-visible read, event navigation, and redacted candidate-safe summaries.
  - Verify: shared-timestamp pagination does not skip/duplicate; foreign IDs remain unmarked; mobile focus trap and Escape behavior pass.

- [x] **Expose bounded ICS export**
  - Files: `src/modules/calendar/components/CalendarExportDialog.tsx`, `src/modules/calendar/components/CalendarPage.tsx`, `src/routes/api/calendar/export[.]ics.ts`, `tests/e2e/calendar.spec.ts`
  - Do: Let the user select a bounded date range, explain that the snapshot contains private calendar data, request the authenticated export, and download only on success.
  - Verify: valid export downloads `text/calendar` with `private, no-store`; invalid/unbounded ranges and signed-out requests fail without a download.

- [x] **Connect booked scheduling to Calendar and Interviews**
  - Files: `src/modules/scheduling/components/InvitationStatus.tsx`, `src/modules/calendar/components/EventDetails.tsx`, `src/modules/interviews/components/InterviewList.tsx`, `tests/e2e/scheduling-organizer.spec.ts`
  - Do: Add View in Calendar, Prepare brief, and Start/Rejoin actions when the invitation/event state permits; preserve safe external meeting links as secondary actions.
  - Verify: draft/sent/opened/booked/cancelled states expose only valid actions and navigate to the correct event/interview.

- [x] **Build a central invitation management hub**
  - Files: `src/routes/_dashboard/interviews/invitations.tsx`, `src/modules/scheduling/components/InvitationList.tsx`, `src/modules/scheduling/components/InvitationStatus.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `src/routes/api/scheduling/invitations/index.ts`, `tests/e2e/scheduling-organizer.spec.ts`
  - Do: Add Invitations under Pipeline with filters for draft/sent/opened/booked/declined/revoked, pagination, draft resume/preview/send, revoke, and links to builder, Calendar, brief, and live interview when valid.
  - Verify: refresh preserves discoverability of a draft; every lifecycle state exposes only legal actions; tenant and role negative cases pass.

- [x] **Implement atomic candidate rescheduling**
  - Files: `src/modules/scheduling/components/CandidatePortal.tsx`, `src/routes/api/public/scheduling/$invitationId/reschedule.ts`, `src/shared/lib/scheduling-api-routes.ts`, `tests/e2e/scheduling-candidate.spec.ts`
  - Do: Replace cancel-then-book with select-new-slot then atomic reschedule. Keep the old booking on 409 or network failure, refresh alternatives, and reconcile the typed scheduling route registry with reschedule/cancel/decline.
  - Verify: success moves exactly once; conflict, stale token, rate limit, and offline retry preserve the previous booking and never create duplicates.

- [x] **Add interview participant material-access controls**
  - Files: `src/modules/interviews/components/InterviewParticipantsPanel.tsx`, `src/modules/interviews/components/InterviewWorkspace.tsx`, `src/routes/api/interviews/$interviewId/participants/$participantId.ts`, `src/shared/lib/interview-api-routes.ts`, `tests/e2e/interview-material-access.spec.ts`
  - Do: Let the interview owner explicitly grant/revoke brief, report, and transcript access per participant, independently of calendar attendance. Show effective access, confirmation, pending/error states, and audit result.
  - Verify: each permission gates its material independently; non-owner, cross-tenant, removed participant, and revoked-access cases fail closed.

- [x] **Add a tenant-safe Shared with me interview list**
  - Files: `src/shared/lib/repositories/interviews.ts`, `src/routes/api/interviews/shared.ts`, `src/modules/interviews/components/InterviewList.tsx`, `tests/e2e/interview-material-access.spec.ts`
  - Do: Add a bounded projection of interviews where the current user has at least one active material grant, with only fields needed for navigation and visible material badges. Add a `Shared with me` section without broadening the owner list endpoint.
  - Verify: recipient discovers only granted interviews; revoke removes the row; UUID guessing, another organization, and attendance-only participation reveal nothing.

## Wave 4 — Claimant and trust UI

- [x] **Add verified-subject provenance UI**
  - Files: `src/modules/builder-profile/components/EvidenceProvenancePanel.tsx`, `src/routes/_dashboard/me/index.tsx`, `src/routes/api/me/builder/$builderId/evidence-provenance.ts`, `tests/unit/modules/builder-profile/components/EvidenceProvenancePanel.test.tsx`
  - Do: Show only source, field categories, observation date, and retention state for a verified claimant; include loading, empty, error, and restricted states; link to Privacy and profile removal guidance.
  - Verify: claimant sees the allowlisted projection; another user, another builder, and random ID reveal no tenant/recruiter/reviewer/note/score data.

- [x] **Add restrict-processing confirmation and state**
  - Files: `src/modules/builder-profile/components/EvidenceProvenancePanel.tsx`, `src/routes/_dashboard/me/index.tsx`, `src/routes/api/me/builder/$builderId/restrict-processing.ts`, `tests/e2e/profile-enrichment-privacy.spec.ts`
  - Do: Explain future-job cancellation and bounded evidence purge, require explicit confirmation, submit idempotently, and replace controls with a durable restricted state.
  - Verify: verified claimant restricts once and repeats safely; running work stops; non-claimant cannot observe or mutate the state.

- [x] **Render a real status subscription form**
  - Files: `src/routes/_landing/status.tsx`, `src/routes/api/status/subscribe.ts`, `tests/unit/routes/status.test.tsx`, `tests/e2e/public-content.spec.ts`
  - Do: Replace “Subscribe via changelog” with email input, validation, uniform success copy, loading, rate-limit, generic error, and unsubscribe-result states; preserve public shell behavior for signed-in and signed-out users.
  - Verify: new and existing email return indistinguishable UI; mail fixture receives incident and resolution messages; unsubscribe stops later mail.

- [x] **Make Status render only real health checks**
  - Files: `src/routes/api/status/index.ts`, `src/routes/_landing/status.tsx`, `src/shared/lib/status.ts`, `tests/unit/routes/status.test.tsx`, `tests/e2e/public-content.spec.ts`
  - Do: Render the complete server-returned check set, including memory, with measured status and explanation. Remove hard-coded Search/API OK rows unless backend checks are implemented. Guarantee degraded overall state names a visible degraded/unknown component.
  - Verify: db, Redis, memory, partial-response, timeout, and all-healthy fixtures agree between overall and rows; no fake healthy component is rendered.

- [x] **Record profile views and show owner aggregates**
  - Files: `src/routes/builders/$builderId.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/modules/builder-profile/components/ProfileViewAnalytics.tsx`, `src/routes/_dashboard/me/index.tsx`, `src/routes/api/builders/$builderId/views.ts`, `tests/e2e/profile-view-analytics.spec.ts`
  - Do: POST eligible consent-aware profile views without blocking render; add verified-owner total and 30-day daily chart with minimum-cohort/empty states. Never expose viewer identity, organization, query, or referrer.
  - Verify: eligible views aggregate once per policy; signed-out/451/ineligible calls fail quietly; non-owner and unverified claimant cannot read aggregates.

- [x] **Build platform-admin claim management projection**
  - Files: `src/shared/lib/repositories/builder-claims.ts`, `src/routes/api/admin/builder-claims/index.ts`, `tests/unit/security/builder-claims-admin.test.ts`
  - Do: Add bounded cursor pagination and allowlisted filters/DTO fields for claim status, source proof, claimant, verification dates, and portfolio publication. Use the platform role and audit reads without exposing raw proof tokens.
  - Verify: platform admin can page/filter; organization admins and unauthenticated callers are denied; DTO snapshot excludes secrets and raw metadata.

- [x] **Build Admin Claims UI and revocation flow**
  - Files: `src/routes/_dashboard/admin/claims.tsx`, `src/modules/admin/claims/ClaimsPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/e2e/admin-claims.spec.ts`
  - Do: Add list, filters, detail drawer, public preview links, portfolio state, and revoke confirmation with reason against the existing revoke endpoint; add Claims to Admin navigation.
  - Verify: revoke invalidates public profile/portfolio immediately, writes audit evidence, and is unavailable to non-platform admins.

- [x] **Expose alert test delivery**
  - Files: `src/routes/_dashboard/alerts.tsx`, `src/routes/api/alerts/test-trigger.ts`, `tests/e2e/alerts.spec.ts`
  - Do: Add per-alert Send test action with confirmation of channel/frequency, pending state, delivered/degraded result, and rate-limit feedback.
  - Verify: in-app and email-fixture paths work; disabled/deleted/foreign alerts cannot be tested.

## Wave 5 — Operator UI

- [x] **Add a redacted operations projection API**
  - Files: `src/shared/lib/repositories/platform-operations.ts`, `src/shared/lib/operational-schedules.ts`, `src/routes/api/admin/operations/index.ts`, `tests/unit/security/admin-operations.test.ts`
  - Do: Return one bounded row per registered schedule with enabled/cadence/timezone/next run and latest run status/duration/counters/redacted error code. Never return payloads, source URLs, candidate data, headers, tokens, or stack traces.
  - Verify: DTO snapshot is redacted; stale/overdue/running/failed/success states calculate correctly; platform-admin boundary passes.

- [x] **Add allowlisted pause, resume, and manual-run APIs**
  - Files: `src/shared/lib/operational-schedules.ts`, `src/shared/lib/repositories/platform-operations.ts`, `src/routes/api/admin/operations/$jobKey.ts`, `src/routes/api/admin/operations/$jobKey/run.ts`, `tests/unit/security/admin-operations.test.ts`
  - Do: Resolve `jobKey` only through `OPERATIONAL_SCHEDULES`; never accept a route or arbitrary argument from the browser. Add optimistic versioning, idempotency, step-up requirement, and audit records.
  - Verify: unknown/traversal job keys fail closed; duplicate manual run does not duplicate work; pause survives registry sync; every mutation is audited.

- [x] **Build Admin Operations UI**
  - Files: `src/routes/_dashboard/admin/operations.tsx`, `src/modules/admin/operations/OperationsPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/e2e/admin-operations.spec.ts`
  - Do: Add status summary, filters, job rows, next/last run, duration/counters, redacted error, pause/resume, manual-run confirmation, refresh, and runbook link; add Operations to Admin navigation.
  - Verify: keyboard and mobile table/card layouts work; platform admin can run/pause/resume; non-admin never sees the destination or data.

- [x] **Add a redacted integration and AI health API**
  - Files: `src/lib/sources/types.ts`, `src/shared/lib/ai/tasks.ts`, `src/routes/api/admin/integrations/index.ts`, `tests/unit/security/admin-integrations.test.ts`
  - Do: Build typed rows from `SOURCE_NAMES` plus AI tasks: enabled/dark/dormant, credential-present boolean, quota, last success/failure, indexed/backlog counts, kill-switch state, provider availability, task version, and budget-error counts. Never expose credential values, provider payloads, prompts, or user input.
  - Verify: the type check fails when a source lacks a row; DTO redaction snapshot and platform-admin boundary pass.

- [x] **Build Admin Integrations UI**
  - Files: `src/routes/_dashboard/admin/integrations.tsx`, `src/modules/admin/integrations/IntegrationsPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/e2e/admin-integrations.spec.ts`
  - Do: Render source and AI health, filters, honest dormant reasons, last run/quota, and links to Operations, Metrics, source-filtered Search, and runbooks; add Integrations to Admin navigation. Do not add secret editors.
  - Verify: all source enum members render; disabled Product Hunt/Devpost/enrichment and unavailable AI states are explicit; no secret-like text appears in DOM.

- [ ] **Add guarded billing operations actions**
  - Files: `src/modules/admin/billing/BillingOperationsPage.tsx`, `src/routes/api/admin/billing/reconcile.ts`, `src/routes/api/admin/billing/events/$eventId/replay.ts`, `src/routes/api/admin/billing/risk-exceptions.ts`, `src/routes/api/admin/billing/accounting-export.ts`, `src/routes/api/admin/billing/run-worker.ts`, `tests/e2e/billing-operations.spec.ts`
  - Do: Add reconciliation, dead-letter lookup/replay, risk-exception management, worker run, bounded accounting export, and Refunds/Disputes links. Require confirmation, step-up where applicable, idempotency, and audit feedback.
  - Verify: fake-provider E2E covers success, repeat, stale, forbidden, and failed-event paths; raw Stripe payloads and secrets never render.

- [ ] **Add billing webhook and dead-letter discovery**
  - Files: `src/shared/lib/repositories/billing-events.ts`, `src/routes/api/admin/billing/events/index.ts`, `src/routes/api/admin/billing/events/$eventId.ts`, `src/modules/admin/billing/BillingOperationsPage.tsx`, `tests/e2e/billing-operations.spec.ts`
  - Do: Add bounded status/type/date filters, redacted detail, retry history, and replay eligibility so operators can find a failed event before invoking the existing replay action. Never return provider payload, headers, payment data, or secrets.
  - Verify: failed/stale/replayed events are discoverable and correctly gated; raw fixture secrets are absent from API snapshots and DOM; pagination is stable.

- [ ] **Align Admin Users with organization-owned billing**
  - Files: `src/modules/admin/users/AdminUsersPage.tsx`, `src/routes/api/admin/users.ts`, `src/modules/admin/billing/BillingOperationsPage.tsx`, `tests/e2e/admin-users.spec.ts`
  - Do: Show owning organization and canonical entitlement including Pro Max; label user-level controls as audited manual grants/exceptions and link to Billing Operations. Do not present them as Stripe subscription editing.
  - Verify: canonical paid, manual exception, expired exception, and no-organization fixtures are distinguishable; mutations remain step-up protected and audited.

- [ ] **Render conversion metrics in Admin Metrics**
  - Files: `src/routes/_dashboard/admin/metrics.tsx`, `src/routes/api/admin/metrics/conversion.ts`, `tests/unit/routes/admin/metrics.test.tsx`
  - Do: Fetch and render the bounded funnel, retention window, variant breakdown, and insufficient-data state; link anomalous API-error or conversion states to the appropriate operations/content page.
  - Verify: empty, insufficient, healthy, and degraded fixtures render without fabricating rates.

- [ ] **Render redacted removal operations metrics**
  - Files: `src/routes/api/admin/metrics/trust.ts`, `src/routes/_dashboard/admin/metrics.tsx`, `src/shared/lib/repositories/profile-removals.ts`, `tests/unit/routes/admin/metrics.test.tsx`
  - Do: Add bounded counts by removal state/source and aging buckets, with small-cohort suppression and Operations links for overdue work. Exclude identity, URLs, request text, evidence, and arbitrary metadata.
  - Verify: empty/suppressed/healthy/overdue fixtures render; DTO snapshot and platform-admin negative tests prove redaction.

## Wave 6 — Public navigation and cross-links

- [ ] **Build responsive public product navigation**
  - Files: `src/shared/components/Header.tsx`, `src/shared/components/PublicNavDrawer.tsx`, `src/routes/_landing/route.tsx`, `tests/unit/shared/components/Header.test.tsx`, `tests/e2e/public-content.spec.ts`
  - Do: Expose Explore, Pricing, Blog, Changelog, Roadmap, Status, and Security through Product/Learn/Trust groupings; retain Home anchors; add a keyboard-accessible mobile drawer with current-route state.
  - Verify: every destination is reachable at desktop and 320 px without scrolling to the footer; focus return, Escape, overlay click, and reduced motion pass.

- [ ] **Add public/admin preview and profile/portfolio cross-links**
  - Files: `src/modules/admin/content/ContentStudioPage.tsx`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `src/routes/builders/$builderId.tsx`, `src/routes/_dashboard/me/index.tsx`, `tests/e2e/public-content.spec.ts`, `tests/e2e/portfolio-builder.spec.ts`
  - Do: Add public preview links from content management, public builder ↔ published portfolio links, and portfolio-owner return to Account. Show links only when the allowlisted public target exists.
  - Verify: unpublished/revoked/missing targets render no link; published targets round-trip correctly.

- [ ] **Connect paid-state actions consistently**
  - Files: `src/modules/solutions/components/SolutionsPage.tsx`, `src/modules/interviews/components/CreditBalance.tsx`, `src/modules/builder-profile/components/WorkSamplePanel.tsx`, `src/modules/search/components/SearchPage.tsx`, `tests/unit/modules/billing/paid-state-links.test.tsx`
  - Do: In authenticated surfaces, offer Billing settings as the primary action and Pricing details as secondary; preserve intended return path after checkout/sign-in.
  - Verify: Free, Pro, Pro Max, Team, past-due, and stale-session states expose only valid actions.

- [ ] **Build a scoped Export Center and reconcile public claims**
  - Files: `src/modules/dashboard/components/ExportsPage.tsx`, `src/routes/api/export/builders.ts`, `src/routes/__root.tsx`, `src/routes/_landing/index.tsx`, `tests/e2e/exports.spec.ts`, `tests/e2e/public-content.spec.ts`
  - Do: Support explicit authorized scope (all tracked, one shortlist, saved-search results, or note collection) and CSV/JSON with bounded generation, progress/error, and permission copy. Until a scope/format is implemented, remove it from Home, FAQ, structured metadata, and product copy.
  - Verify: every advertised scope-format pair downloads valid bounded data; foreign/private scopes fail; a copy-contract test fails when public claims exceed the capability registry.

## Wave 7 — Optional adapters and honest incomplete features

- [ ] **Add opt-in AI persona to public portfolios**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/modules/builder-profile/components/PortfolioSettings.tsx`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `tests/unit/shared/lib/portfolio-integrations.test.ts`
  - Do: Parse the existing versioned persona artifact, require explicit owner opt-in, expose only summary/focus/strengths/provenance, and never invoke AI from a public request.
  - Verify: absent, invalid, stale-policy-disabled, opted-out, and opted-in valid artifacts behave fail-closed.

- [ ] **Add opt-in public timeline to portfolios**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/modules/builder-profile/components/PortfolioSettings.tsx`, `src/modules/builder-profile/components/PortfolioTimelineSlot.tsx`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `tests/unit/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`
  - Do: Render only owner-selected public events; preserve lazy degradation; hide summary controls when neither local nor authenticated proxy AI is usable.
  - Verify: dependency absent, unavailable AI, valid timeline, invalid timeline, and revoked publication states pass.

- [ ] **Make Solutions preview state honest and dependency-aware**
  - Files: `src/modules/solutions/components/SolutionsPage.tsx`, `src/shared/lib/solutions/config.ts`, `src/routes/_dashboard/solutions/index.tsx`, `tests/unit/modules/solutions/components/SolutionsPage.test.tsx`
  - Do: Label fixture lanes as demo/preview, expose server-owned prerequisite readiness, remove production-success wording, and keep the same route ready for real plan 43 endpoints.
  - Verify: incomplete prerequisites can never render an unlabeled generated-result success state.

- [ ] **Bind Solutions UI to real plan 43 endpoints after prerequisites ship**
  - Files: `src/modules/solutions/components/SolutionsPage.tsx`, `src/routes/api/solutions/index.ts`, `src/routes/api/solutions/$solutionId.ts`, `tests/e2e/solutions.spec.ts`
  - Do: Replace demo fixtures with real brief interpretation, clarification, explicit charge confirmation, generation progress, evidence-backed result lanes, and deterministic error/retry states. Do not duplicate plan 43's domain services.
  - Verify: real Pro/Pro Max/Team journey passes against the fake provider and real database; Free, insufficient-credit, unavailable route, stale version, and cross-tenant cases fail honestly.

## Wave 8 — Release gates

- [ ] **Add complete UI journey E2E coverage**
  - Files: `tests/e2e/builder-workspace-navigation.spec.ts`, `tests/e2e/calendar.spec.ts`, `tests/e2e/scheduling-candidate.spec.ts`, `tests/e2e/interview-material-access.spec.ts`, `tests/e2e/profile-enrichment-privacy.spec.ts`, `tests/e2e/profile-view-analytics.spec.ts`, `tests/e2e/admin-claims.spec.ts`, `tests/e2e/admin-operations.spec.ts`, `tests/e2e/billing-operations.spec.ts`, `tests/e2e/exports.spec.ts`, `tests/e2e/public-content.spec.ts`
  - Do: Cover every journey enumerated in `plan.md` with real Postgres, real runtime roles, deterministic provider/email seams, desktop and mobile projects, and no broad mocks.
  - Verify: run the selected suite twice consecutively with zero retries and no unexpected console/network errors.

- [ ] **Add accessibility and responsive gates for every new surface**
  - Files: `tests/regression/test-accessibility.mjs`, `tests/e2e/accessibility.spec.ts`, `tests/e2e/responsive-layout.spec.ts`
  - Do: Cover dialogs, drawers, menus, forms, data tables/cards, calendar views, live regions, focus return, keyboard-only actions, reduced motion, zoom, 320 px, 768 px, and desktop.
  - Verify: `pnpm test:a11y` passes with no critical/serious violations; responsive suite has no horizontal document overflow.

- [ ] **Add visual snapshots and route-structure checks to CI**
  - Files: `tests/e2e/visual/ui-coverage.spec.ts`, `.github/workflows/quality.yml`, `package.json`
  - Do: Snapshot Calendar views/agenda, Operations, Integrations, Claims, status form, and public mobile navigation; require route-graph and visual structural checks in CI.
  - Verify: intentionally change one key layout and one route to prove each gate fails, restore baselines, then run `pnpm test:visual` and `node scripts/check-ui-route-graph.mjs`.

- [ ] **Run the full completion gate and reconcile source plans**
  - Files: `plans/UI/spec.md`, `plans/UI/plan.md`, `plans/UI/tasks.md`, affected `plans/phase-1/*/{spec,plan,tasks}.md`, `plans/_meta/app-reality.md`, `plans/_meta/phase-1-order.md`
  - Do: Run all commands from `plan.md`; update checked Phase 1 claims that were contradicted by the audit, especially Calendar and Status subscription; record exact browser/runtime evidence and leave genuinely external/elapsed-time work unchecked.
  - Verify: `pnpm plans:check-order`, `pnpm plans:check-tasks`, `pnpm type-check`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, `pnpm test:a11y`, `pnpm test:visual`, `pnpm build`, and `pnpm ci:local` are green; core UI journeys pass twice consecutively.
