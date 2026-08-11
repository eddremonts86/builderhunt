# Action-Centered Dashboard

> **Status**: `pending`
> **Audience**: recruiters, team members, organization owners/admins, and verified profile owners
> **Depends on**: selected deliverables from [`plans/UI`](../../implemented/56-UI/spec.md), [`saved-search-health`](../../phase-4/saved-search-health/spec.md), and [`hiring-pipeline-kanban`](../../phase-4/hiring-pipeline-kanban/spec.md)
> **Canonical surface**: `/dashboard`
> **Reality check**: the current dashboard already has banners, four metric tiles, activity, sprints, recommendations, alerts, saved searches, recent builders, plan usage, and source mix. The problem is not an empty dashboard; it is weak prioritization, ambiguous data semantics, disconnected workflows, and incomplete failure/accessibility states.

## Purpose

Turn the dashboard into the fastest safe answer to five questions:

1. What needs my attention now?
2. What changed since I last worked?
3. Who should I review or contact next?
4. What is moving, blocked, or approaching a deadline?
5. What should I do next, and where does that action continue?

The dashboard is a command surface, not a collection of every number BuilderHunt can compute. Every default widget must support a decision or provide a direct continuation into a feature page.

## Product and design direction

BuilderHunt is a multi-tenant sourcing and hiring workspace. The dashboard should feel operational, calm, and evidence-led:

- action first, analytics second;
- moderate information density with progressive disclosure;
- exact labels, time windows, scope, and freshness on every aggregate;
- one primary action per row or card;
- stable spatial order across desktop, mobile, keyboard, and screen readers;
- minimal motion and no decorative visualization;
- role-aware defaults without leaking data and then hiding it in the browser.

## Evidence from the current implementation

The audit reviewed `DashboardPage.tsx`, the dashboard navigation registry, dashboard APIs, scheduling/interview/calendar APIs, alerts, sprints, recommendations, lists, activity, billing, the Phase 1 plans, the relevant Phase 4 plans, and the previous UI coverage plan.

### Current structural problems

1. **Inventory beats urgency.** Four top metrics describe stored objects, while upcoming interviews, unprepared meetings, unread signals, and stalled work are not prioritized together.
2. **Failures look empty.** Several secondary requests degrade to an empty widget, so a user cannot distinguish “nothing here” from “data unavailable.”
3. **Visual and focus order may diverge.** The bento grid uses dense placement although widgets contain links and controls. This can produce a keyboard sequence that does not match the visual sequence.
4. **The activity chart is mislabeled.** Its seven bars group each tracked builder by `lastSeenAt`; they are not events shipped by the user or total daily activity. The current “Weekly Activity” framing overstates the data.
5. **Source mix is sampled.** It is derived from recent builders, not the whole workspace. The caption acknowledges the sample, but the chart cannot answer workspace coverage.
6. **Usage has two truths.** The widget uses the legacy plan endpoint while `/api/billing/summary` is the canonical role-minimized source.
7. **Primary actions are duplicated.** Search and New hunt currently continue to the same place.
8. **Banners and widgets compete.** Onboarding and invitations sit outside the widget priority model instead of being part of one ordered action queue.
9. **Charts omit equivalent data.** The existing bar chart has no per-point accessible labels or exact-value table.
10. **Local preferences are fragile.** Density is stored only in local storage and is not scoped to the current user and organization.

## Operating model

The dashboard is ordered by urgency, then time, then workflow, then supporting analytics:

1. **Action queue** — work requiring a decision now.
2. **Today and upcoming** — interviews, meetings, deadlines, and preparation.
3. **Pipeline and discovery** — movement, stalled work, and candidates to review.
4. **Signals and collaboration** — alerts, saved-search health, sprints, shortlists, and team activity.
5. **Capacity and coverage** — plan/credit/seat pressure and source coverage.

Critical workflow, security, or billing notices cannot be hidden. Optional informational widgets can be hidden or reordered.

## Current widget disposition

| Current surface | Decision | Required change |
|---|---|---|
| First-hunt empty state | Keep | Make it the single new-work CTA and explain what will appear after the first search. |
| Builders tracked | Evolve | Add a bounded comparison or replace it with newly tracked in the selected period; link to the tracked-builder destination. |
| Active this week | Rename/rebuild | Define “active” precisely. Do not reuse `lastSeenAt` as event volume. |
| Saved searches | Evolve | Show searches needing attention after saved-search health ships; otherwise retain exact total as secondary context. |
| Private notes | Remove from default | Notes count has no obvious decision. Keep it only in a customizable secondary summary if research proves demand. |
| Activity chart | Rebuild | Immediately label it as tracked builders by latest-seen day, or replace it with a real event/tracked-builder time series. Add exact values and accessible summary. |
| Sprints | Keep and elevate conditionally | Prioritize stalled, paused, completed-with-results, or quota-limited sprints; link to the relevant sprint. |
| Recommendations | Keep, consolidate | Present a bounded review queue and continue into the internal builder workspace; external profile remains secondary. |
| Alerts | Keep, prioritize | Rank unread/actionable triggers and link to alert or internal builder context. |
| Saved-search list | Merge | Combine with health and alerts to avoid three competing signal lists. |
| Recent builders | Keep as secondary | Rename scope explicitly and make internal builder workspace the primary continuation. |
| Plan usage | Rebuild | Use canonical billing summary; expose only role-authorized financial details. |
| Source mix | Rebuild | Aggregate all tracked builders or saved-search configuration, not the recent sample. Link to source-filtered Search. |
| Onboarding banner | Merge | Represent incomplete setup as a dismissible action-queue item. |
| Pending invitations banner | Merge | Represent invitations as a role-safe action-queue item with direct continuation. |

## Widget catalog

### P0 — Default for every eligible workspace

| Widget | Question answered | Data and eligibility | Primary continuation | Visual treatment |
|---|---|---|---|---|
| Action queue | What needs attention now? | Server-derived, tenant- and role-scoped rules | Deep link for each item | Ordered list with severity, reason, due time, and one action |
| Today and upcoming | What is happening next? | Calendar feed, interview ownership/access, scheduling state | Join, prepare, or open Calendar | Compact agenda/timeline; not a chart |
| Candidates to review | Who should I review next? | Recommendations, unread alert matches, completed sprint results | Internal builder workspace | Ranked cards with source/evidence and reason |
| Active work | What work is progressing or stuck? | Sprints and saved searches; pipeline when available | Sprint, saved search, or pipeline | Status rows and compact progress bars |
| Workspace usage | Am I approaching a limit? | Canonical billing summary, minimized by role | Billing or upgrade/request flow | Exact progress meters; no gauge |

Action-queue rules, in descending default priority:

1. payment or entitlement problem visible to an authorized owner/admin;
2. interview starting soon with no brief;
3. calendar conflict or missing availability blocking scheduling;
4. candidate invitation in a state requiring organizer action;
5. unread high-value alert or completed sprint with unreviewed results;
6. stalled/paused sprint or unhealthy saved search;
7. pending organization invitation or incomplete onboarding;
8. plan, credit, or seat threshold warning.

The server returns an allowlisted action kind and safe resource identifiers. The browser maps those kinds through the typed route registry; it never renders arbitrary server-provided URLs.

### P1 — Default by role or journey

| Widget | Default audience | Value | Dependency |
|---|---|---|---|
| Pipeline snapshot | Recruiters, owners | Stage distribution, aging, and stuck candidates | Hiring pipeline Kanban |
| Saved-search health | Search owners | Healthy/tune/kill/unmonitored counts and top issues | Saved-search health |
| Shortlists | Recruiters | Recently updated lists, top list counts, uncategorized candidates | Shortlist navigation and metadata work from `plans/UI` |
| Invitation status | Organizers | Draft/sent/opened/booked/declined/revoked distribution and next actions | Central invitation management from `plans/UI` |
| Team activity | Organization teams | Human-readable recent actions and safe target links | Activity projection improvements from `plans/UI` |
| Source coverage | Search-heavy users | Underused and dominant sources across the real workspace scope | New aggregate projection |
| Alert volume | Alert users | Trigger volume over a bounded period, separated by type only when useful | Existing trigger timestamps plus aggregate projection |

### P2 — Optional, not a default recruiter widget

| Widget | Audience | Constraint |
|---|---|---|
| Claimed-profile summary | Verified profile owners | Prefer `/me`; dashboard widget is opt-in and shows only owner-safe aggregates and publication state. |
| System status | All users during degradation | Contextual notice only. Full checks remain on Status; operational graphs remain under Admin. |
| Platform-admin attention | Platform admins | A small count/link may be shown on `/dashboard`, but platform-wide data and actions live in the dedicated `/admin` Command Center below. |

## Specialized admin widgets

Administrative dashboards have two distinct scopes. They share accessible widget primitives and
section-state contracts, but they must not share one response or infer authorization from client-side
visibility.

### Organization Admin section on `/dashboard`

This section is available only to authorized organization owners/admins and remains scoped to the
active organization. It appears after the normal workflow widgets so administration does not displace
the hiring work the administrator is also performing. A critical access, billing, or security issue is
promoted into the Action queue.

| Widget | Operating question | Data | Primary action | Visualization |
|---|---|---|---|---|
| Members and seats | Are access and paid seats configured correctly? | Active members, pending/expired invitations, seat allowance, seats used | Manage Team | Exact progress meter and status rows |
| Roles and access review | Does anyone have elevated or stale access requiring review? | Role counts, ownership state, pending ownership transfer, active sessions only when authorized | Review members or Security | Ranked counts; no employee score |
| Billing and entitlements | Is the workspace paid, healthy, and within limits? | Canonical subscription state, credits, renewal, payment/entitlement warnings | Open Billing | Progress meters and dated status; financial values owner-only |
| Team coordination | Is work distributed or blocked? | Active sprints, upcoming interviews without preparation, invitation follow-ups, saved-search owners | Open relevant workflow | Ordered issue list, not productivity ranking |
| Workspace adoption | Which product areas are configured and used? | Bounded feature activation: saved searches, alerts, sprints, shortlists, calendar setup | Configure missing feature | Checklist/status distribution, not user surveillance |
| Security posture | Is immediate account action required? | MFA/session/security settings that existing APIs can safely aggregate | Open Security | Text status and checklist; never expose tokens or session secrets |
| Data and privacy requests | Are there organization-level requests awaiting an authorized action? | Only request counts/statuses the role may legally see | Open Privacy or request destination | Aging/status rows with minimum necessary fields |

Organization-admin constraints:

- Never rank individual employees by searches, notes, activity, or “productivity.”
- Do not reveal private member notes, search content, interview material, candidate emails, or session
  details in aggregates.
- Financial values and destructive organization actions remain owner-only where the canonical policy
  requires it; an admin sees availability/status, not hidden financial detail.
- Team coordination shows blocked workflow objects, not judgments about people.
- “Adoption” means feature setup/usage at organization level and is not a performance score.

### Platform Admin Command Center on `/admin`

Create an intentional `/admin` landing page for platform administrators. The current navigation owns
an Admin area with Metrics, Users, Plan requests, Incidents, Abuse, Billing operations, Refunds,
Disputes, Content, Changelog, and Roadmap, but it has no index route. The Command Center summarizes
attention across those destinations; it does not replace their detailed pages.

Default order follows incident risk and actionability:

| Widget | Operating question | Existing or planned source | Primary action | Visualization |
|---|---|---|---|---|
| Platform action queue | What requires an operator decision now? | Incidents, failed/overdue jobs, billing alerts, disputes/refunds, abuse risk, claim/removal queues | Open exact admin destination | Prioritized issue list with severity, age, owner/state |
| Service health and incidents | Is the user-facing platform healthy? | Status snapshot and incidents | Open Incidents or public Status | Status matrix and incident timeline; no fake checks |
| Worker and integration health | Which scheduled capability is failing, late, disabled, or saturated? | Operations/integration projections planned in `plans/UI` | Open Operations/Integrations | Status rows; bounded duration/error-rate bars where measured |
| Billing operations | Is money movement or entitlement processing unhealthy? | Billing operations metrics, refunds, disputes, risk exceptions, dead letters | Open Billing ops/Refunds/Disputes | Exact alerts, aging buckets, reconciliation status |
| Abuse and trust | Is there a high-risk account or trust workflow awaiting review? | Abuse signals/clusters and redacted trust/removal aggregates | Open Abuse/Claims/Trust destination | Severity distribution and aging; no subject content |
| User and entitlement anomalies | Are accounts or organization entitlements inconsistent? | Admin users plus canonical billing ownership | Open exact user or Billing ops | Exception list and bounded counts |
| Growth and conversion | Did acquisition or activation materially change? | Admin metrics and conversion projection | Open Metrics | Cohort/funnel only when canonical events and denominator exist |
| Public content operations | Is public communication stale or blocked? | Changelog, Roadmap, incident communication state | Open content destination | Status checklist and aging; no vanity page-view chart |

Current and planned Admin destinations map to the Command Center as follows:

| Admin feature | Command Center owner | Treatment |
|---|---|---|
| Metrics and conversion | Growth and conversion | Summary plus drill-down; suppress rates for insufficient cohorts. |
| Users and entitlement exceptions | User and entitlement anomalies | Only bounded exceptions requiring review; never a user directory mirror. |
| Plan requests | None by default | The current API marks self-service plan requests as retired; remove/redirect the stale destination rather than create a dead widget. |
| Incidents and status snapshot | Service health and incidents | Measured checks, open incident severity/age, and public Status continuation. |
| Abuse console and clusters | Abuse and trust | Redacted severity/aging; detailed evidence and enforcement remain in Abuse. |
| Billing ops, refunds, and disputes | Billing operations | Alert/reconciliation/case-aging summaries with separate drill-downs. |
| Content, Changelog, Roadmap, and SEO | Public content operations | Publishing/communication/SEO readiness checklist only when a real measurement exists. |
| Claims, privacy, and removal operations | Abuse and trust | Add after the bounded projections and Admin destinations in `plans/UI` ship. |
| Worker schedules and integrations | Worker and integration health | Add after Operations/Integrations projections in `plans/UI` ship. |

Platform-admin action priorities:

1. active critical incident or security/abuse risk;
2. billing consistency, dispute, refund, or entitlement failure with user impact;
3. failed/overdue worker that blocks a user-facing capability;
4. trust, claim, privacy, or removal request approaching its policy deadline;
5. unresolved platform configuration/anomaly;
6. conversion or content signal requiring investigation but no immediate outage response.

### Admin-only visualizations

| Visualization | Decision | Required data | Form | Guardrail |
|---|---|---|---|---|
| Incident state and aging | What is open and how long has it remained unresolved? | Canonical incident status/severity/timestamps | Aging buckets plus incident list | Link to incidents; no average that hides a critical outlier |
| Job health matrix | Which workers are failed, overdue, running, paused, or healthy? | Registered schedules and latest run state | Status matrix with last/next run | Never render worker API routes as clickable GET links |
| Job duration/error change | Did a worker degrade? | Comparable run history with duration/error counters | Small time series with threshold | Omit when history or units are not comparable |
| Billing alert pressure | Which financial operational threshold is breached? | Canonical billing alert evaluator | Threshold rows and bounded trend | No raw provider payload, payment data, or secrets |
| Refund/dispute aging | Which cases require action first? | Current status and created/deadline dates | Aging buckets/ranked bars | Not approval automation |
| Abuse-risk distribution | Is high-risk volume changing? | Redacted risk stages and bounded history | Stacked bars by severity | No identities or automated guilt claim |
| Trust/removal SLA aging | Which privacy/trust workflow is near deadline? | Redacted workflow status and policy dates | Aging buckets | Minimum necessary fields only |
| Conversion funnel | Where does verified product activation drop? | Canonical ordered events, denominator, window, exclusions | Funnel table plus bars | Suppress/label insufficient cohorts; never infer causation |
| Error/latency/throughput | Is the platform healthy and where is the bottleneck? | Stable service metrics with units and thresholds | Overview SLO panels and time series | Keep infrastructure detail in Admin, not tenant dashboard |

Admin visualizations use fixed sane default windows, explicit refresh behavior, units, thresholds, and
drill-down links. Destructive or outward-facing actions—manual worker execution, incident publication,
refund/replay, risk enforcement, claim revocation, or content publication—remain on their canonical
detail pages with step-up, confirmation, idempotency, and audit evidence. The Command Center is not a
one-click mutation console.

### Admin projection and preferences

- Add a versioned, platform-role-protected `GET /api/admin/overview?range=24h|7d|30d` projection.
- Keep it separate from `/api/dashboard/overview`; a cache key or serialization mistake must not mix
  tenant and platform scopes.
- Return bounded counts, redacted issue rows, freshness, and per-section states. Never return provider
  payloads, stack traces, prompts, tokens, payment data, private candidate data, or abuse evidence.
- Use allowlisted admin destination kinds and IDs rather than arbitrary links.
- Persist a separate `admin_dashboard_preferences` namespace so platform layout cannot overwrite an
  organization's dashboard layout.
- Required incident/security/billing-risk widgets cannot be hidden. Optional Growth and Content
  widgets can be hidden or reordered with keyboard-accessible controls.
- Every admin action and sensitive read follows the platform-role, step-up, audit, and reason contracts
  owned by its domain.

## `/admin/metrics` optimization and widget redesign

`/admin/metrics` remains the analytical drill-down for platform health, product activity, discovery,
and conversion. The `/admin` Command Center consumes only a bounded attention summary and links here;
it must not duplicate the complete Metrics board.

### Current implementation audit

The current page and `GET /api/admin/metrics` have several correctness and performance problems:

1. The page renders six in-process counters, DB totals, discovery counters, and one server-process
   snapshot without thresholds, comparison periods, rates, or generated time.
2. In-process counters reset on server restart and represent only the serving process. They are not
   platform totals in a multi-instance deployment, but the UI does not disclose that scope.
3. API requests/errors are shown as cumulative counts instead of request rate and error ratio. Search
   cache hits are shown without total eligible requests or a hit rate.
4. The API returns billing operations metrics and alerts, but the page contract and UI ignore them.
   Producing those metrics performs a cross-organization sweep with nested billing reads on every
   request; the page polls the entire endpoint every 15 seconds.
   **Resolved 2026-08-06.** `/api/admin/metrics` no longer calls `getBillingOperationsMetrics`; the
   alerts moved to `/api/admin/billing/metrics` and render on Billing ops, which is the first time any
   page has displayed one. The refresh now stops while the tab is hidden.
5. `totalSavedQueries`, `totalBuilders`, and `totalNotes` are deliberately returned as `null`, creating
   dead metric cards instead of an explicit unavailable/removed state.
   **Resolved 2026-08-06 by removal, not by an unavailable state.** A tile that can never have a value
   is not information about availability — the counts need `builderhunt_platform` to read tenant
   tables unscoped, and two of the three count private workflow content, so there is nothing for a
   later deploy to fill in.
6. The API already returns onboarding completion/skips and a 7-day activation rate, but the page
   contract omits and never renders them.
7. Interview reliability counters exist in `metrics.ts`, but the page contract omits them and their
   restart-scoped semantics.
8. The conversion endpoint exists, including raw numerator/denominator, Wilson confidence intervals,
   variant, and insufficient-sample state, but `/admin/metrics` never fetches or renders it.
9. Conversion queries execute six metric definitions sequentially, each with two count queries, and
   accept formatted dates without a maximum range or explicit start-before-end validation.
10. One primary request controls the page, so a billing/database failure can hide otherwise useful
    process or discovery data. Secondary state has no stale/generated metadata.
11. Automatic refresh does not pause when the page is hidden, cancel overlap, expose the last success,
    clear a previous error correctly, or announce a user-requested refresh result accessibly.
12. Node version, platform, PID, and raw memory values occupy a default section even though they are
    single-instance diagnostics, not the first operator decision.

### Metrics operating questions

The redesigned page answers, in this order:

1. Is the platform healthy for users right now?
2. Did request volume, error rate, or latency materially change?
3. Are search and discovery producing work efficiently?
4. Are acquisition, signup, onboarding, and activation changing?
5. Where does verified conversion drop, with what sample confidence?
6. Is a feature-specific reliability signal—especially interviews—outside its threshold?
7. Is the data itself fresh, complete, and comparable?

### Page information architecture

The page uses route-persisted `section`, `range`, and, where applicable, `variant` filters. Default
range is 24 hours for operational health and 30 days for product/conversion analysis. Refresh cadence
is section-aware instead of globally polling every panel.

| Section | Default widgets | Refresh | Destination responsibility |
|---|---|---|---|
| Overview | Active alerts, request/error/latency health, data freshness, last deployment/restart scope | 60 seconds or manual | Summarize; link to Incidents/Operations |
| Traffic and performance | Request rate, error ratio, p50/p95/p99 latency, route-family bottlenecks | 60 seconds | Diagnose measured service behavior |
| Search and discovery | Searches, cache hit rate, discovery throughput/errors, last/next run, backlog where measured | 1–5 minutes | Link to Operations/Integrations/Search |
| Acquisition and activation | New users, signups, onboarding completion/skip, activation cohort | 5–15 minutes or manual | Product analytics, not infrastructure health |
| Conversion | Named funnels, numerators/denominators, confidence interval, variant, insufficient sample | Manual/range change | Evidence-led conversion analysis |
| Feature reliability | Interview booking, document, transcript, AI fallback/refusal, retention, and schedule signals | 1–5 minutes | Link to exact Operations/feature runbook |
| Runtime diagnostics | Process uptime, memory, runtime/platform, instance/reset identity | Manual; collapsed | Debug context only, never a platform-health proxy |

Billing does not remain a full Metrics section. `/admin/metrics` may show only a cached alert count and
last evaluated time supplied by the Admin overview projection, then link to `/admin/billing`. Detailed
billing scans, reconciliation, webhooks, ledger invariants, refunds, disputes, and risk belong to
Billing operations.

### Metrics widget catalog

| Widget | Required computation | Visualization | Required action/guardrail |
|---|---|---|---|
| Active operational alerts | Deterministic threshold evaluator across ready sections | Ordered severity list | Link to Incidents/Operations/Billing; no mutation |
| Request health | Rate, error ratio, and latency percentiles over the selected window | Summary cards plus time series | Raw cumulative counts are diagnostic details only |
| Slow/error route families | Allowlisted normalized route family, rate, p95, error ratio | Ranked horizontal bars/table | Never emit raw URL/query/user IDs |
| Search effectiveness | Searches, eligible cache lookups, hits, misses, hit rate, errors, latency | Trend plus exact ratios | Disclose cache eligibility and selected range |
| Discovery throughput | Runs, identities upserted, errors, duration, backlog, last/next run | Status row plus rate/error bars | Cursor/cell key only in diagnostic disclosure |
| Acquisition | Eligible landing/signup counts and new accounts | Daily bars with comparison | Respect analytics-consent cohort definition |
| Onboarding activation | Completed/skipped/new-account denominator within one cohort window | Segmented bar/table | Never divide lifetime completion by recent signups |
| Conversion metrics | Canonical numerator, denominator, rate, CI95, insufficient sample | Funnel table with bars | No causal claim; exact cohort/window/variant visible |
| Interview reliability | Conflicts, document failures/backlog, reconnects/retries, provider/parse/fallback/refusal, stale schedule/reservation, retention failure | Threshold list and bounded trends | No candidate/interview content or IDs |
| Data freshness and gaps | Per-source generated time, last success, reset/deployment scope, unavailable reason | Status matrix | Distinguish zero from unavailable and reset |
| Runtime diagnostics | Per-instance uptime/memory/runtime | Compact definition list | Collapsed; label instance/reset scope explicitly |

### Historical truth and metric sources

- Do not graph cumulative process counters as a time series. Either persist bounded time buckets or
  query a real observability backend before drawing trends, rates, or percentiles.
- Until persistent service metrics exist, display process counters only as “since this process
  started,” with `processStartedAt`, `instanceId`, and last reset/deployment context.
- Multi-instance platform totals require aggregation across instances. A single process snapshot must
  never be labeled platform-wide.
- Product, conversion, and cohort metrics use persisted events/records with explicit UTC boundaries,
  consent rules, exclusions, and denominators.
- Discovery state labels whether its counters are lifetime, current-run, or bounded-window values.
- `null`/unavailable data produces an unavailable state and explanation, not a numeric card containing
  an em dash.

### API and query design

- Replace the monolithic response with a versioned `GET /api/admin/metrics/overview` plus bounded
  section endpoints or a section parameter: `traffic`, `search`, `discovery`, `activation`,
  `conversion`, `features`, and `runtime`.
- Migrate the page and regression consumers before retiring `GET /api/admin/metrics`. During the
  bounded compatibility window, the legacy route must compose the lightweight contracts or return a
  documented deprecation response; it must not preserve the unused cross-organization billing sweep.
- Each section returns `status`, `generatedAt`, `window`, `timezone`, `sourceScope`, units, thresholds,
  and exact series/table data. One section failure cannot fail the whole page.
- Remove the expensive billing operations sweep from the frequently refreshed metrics endpoint. Use
  its own internally cached projection and `/admin/billing` refresh policy.
- Aggregate conversion event counts for all required event names in one bounded repository query (or
  one parallel batch), then compute metrics in memory. Enforce `start <= end`, a maximum 90-day range,
  valid variants, UTC-day semantics, and bounded output.
- Add persisted histogram/time-bucket support before claiming p50/p95/p99 or trends. If unavailable,
  render an honest prerequisite state.
- Normalize route labels through an allowlist to prevent cardinality and sensitive URL leakage.
- Use internal short-lived aggregate caches where useful, but return sensitive Admin responses with
  an appropriate private/no-store browser policy and no CDN sharing.
- Add query cancellation/deduplication, visibility-aware polling, exponential retry, and manual retry.
  Operational panels may refresh every 60 seconds; product/conversion panels refresh on range/filter
  change or explicit request.

### Metrics interactions and accessibility

- Every widget title includes its unit/window or exposes them immediately beside the title.
- Time range, section, variant, comparison, and refresh state are encoded in validated URL search
  parameters so analysis can be bookmarked and shared with another authorized platform admin.
- “Previous period” means the immediately preceding, non-overlapping interval of equal duration in
  the same timezone/cohort rules; custom comparisons show both exact windows.
- Refresh shows last successful generation time and announces only user-requested completion/failure
  through a polite live region.
- Charts expose a concise takeaway, exact values, keyboard/touch equivalents, and a data table.
- Thresholds always show text and units, not color alone; legends explain warning/critical meaning.
- Use a stable DOM order, 320 px reflow, 400% zoom, forced-colors, reduced-motion, and visible focus.
- Large tables use bounded server pagination and sticky semantic headers without trapping horizontal
  keyboard navigation.

### Metrics performance budgets

- Initial Overview must not trigger the cross-organization billing sweep or conversion aggregation.
- No hidden section fetches until visible/prefetched by explicit navigation.
- Default response contains at most 90 time buckets and 10 ranked rows per widget.
- Representative p95 targets: Overview <= 400 ms, one analytical section <= 750 ms after internal
  caching; record exceptions with an explicit plan rather than silently increasing polling.
- Page refresh must not overlap an in-flight request for the same section/range.
- Add query-count and duration instrumentation per section and a CI large-fixture regression gate.

### Metrics non-goals

- Replacing a real observability platform with process-local React widgets.
- Showing raw logs, traces, stack traces, route parameters, payloads, prompts, candidate data, or
  payment data.
- Treating sign-ins, searches, notes, or uptime as success metrics without a decision or comparison.
- Mixing Billing operations detail into Metrics.
- Running workers, publishing incidents, or mutating user/risk/billing state from a chart.
- Claiming causal conversion effects from correlation or insufficient cohorts.

## Informative visualizations

Charts are allowed only when visual comparison is faster than a labeled list. Every chart includes a heading, a one-sentence takeaway, exact scope and period, generated time, exact values, and a table or disclosure exposing the same data.

| Visualization | Decision supported | Honest source/prerequisite | Recommended form | Explicit non-claim |
|---|---|---|---|---|
| Newly tracked builders over 30 days | Is discovery producing reviewable candidates? | Aggregate `createdAt` for organization builders | Daily bars or line with exact table | Not candidate quality or user activity |
| Alert triggers over 14/30 days | Are signals increasing and which type dominates? | Trigger timestamps, optionally allowlisted trigger type | Stacked daily bars | Not hiring conversion |
| Source coverage | Are searches over-dependent on one source? | All tracked builders or configured saved-search sources | Ranked horizontal bars or 100% stacked bar | Not provider quality unless an outcome metric exists |
| Pipeline stage distribution | Where is work concentrated? | Canonical pipeline stages after Kanban ships | Segmented horizontal bar with counts | Not a funnel or conversion rate |
| Pipeline aging | Which stages contain stale candidates? | Stage entry time/history | Aging buckets or ranked bars | Not time-to-hire without completed cohorts |
| Invitation status distribution | What requires organizer follow-up? | Current invitation states | Ranked horizontal bars | Not a conversion funnel; states are a snapshot |
| Interview load | When is the team busiest? | Upcoming calendar/interview events | Week strip or agenda; agenda preferred | Not productivity |
| Shortlist distribution | Which lists contain the work? | Tenant-safe list counts | Top-N horizontal bars plus “other” | Not candidate quality |
| Team activity volume | Is collaboration active and what changed? | Human event stream grouped by allowlisted type | Stacked daily bars | Not employee performance |
| Plan, credits, and seats | What limit is approaching? | Canonical billing summary | Progress meters with exact values | Not financial forecasting |
| Saved-search health | Which searches need tuning or retirement? | Current computed health verdict | Status distribution and issue list | No trend line: the approved design has no snapshots/history |
| Profile views | Is a claimed public profile being discovered? | Privacy-preserving daily owner aggregate | Small daily line/bar chart | No viewer identity or recruiter attribution |

### Visualizations deliberately excluded

- pie and donut charts where ranked bars provide easier comparison;
- gauges and speedometers;
- a pipeline “funnel” without transition/cohort data;
- saved-search health trends without persisted history;
- notes-count charts;
- maps without a concrete location decision;
- platform operations or conversion metrics on the tenant dashboard;
- generated narrative “AI insights” that cannot cite a deterministic rule and source;
- animated charts, autoplay, or hover-only data.

## Information architecture and responsive order

Desktop and mobile share one DOM order:

1. page title, range selector, refresh status, and Customize action;
2. critical notices and Action queue;
3. Today and upcoming;
4. Candidates to review;
5. Active work / Pipeline snapshot;
6. Signals, shortlists, and team activity;
7. Usage and source coverage;
8. optional personal widgets.

The 12-column layout can change spans, but it must not use dense placement to move an interactive widget ahead of an earlier DOM sibling. Mobile becomes a single column in the same sequence. Tables become labeled cards or horizontally scroll only when all key labels remain available and keyboard access is preserved.

For organization owners/admins, the specialized Workspace Admin section follows the shared workflow
sections. Platform administrators reach the separate `/admin` Command Center from the Admin navigation
area or a compact platform-attention link; platform widgets never join the tenant dashboard grid.

## Interaction and navigation contract

Every row answers “why is this here?” and exposes one primary continuation:

- alert match -> alert detail or internal builder workspace;
- recommendation/recent builder -> internal builder workspace;
- sprint issue/result -> exact sprint and result context;
- saved-search issue -> exact saved-search editor/results;
- interview readiness -> brief or interview workspace;
- calendar event -> event detail; external meeting link remains secondary;
- invitation issue -> invitation management state;
- shortlist -> list detail;
- team event -> server-derived, allowlisted target;
- limit warning -> canonical Billing surface;
- source gap -> Search with validated source filters.

Resource links carry only allowlisted same-origin origin context so the destination can provide a meaningful return path. Deleted or unauthorized resources remain non-linked and do not reveal existence.

## Data architecture

Preserve the useful current rule that widget components receive plain data and do not own ad hoc fetches. Replace page-level all-or-nothing loading with an explicit dashboard projection and section state.

### Core endpoint

Add a bounded `GET /api/dashboard/overview?range=7d|30d|90d` projection for the critical shell:

```ts
type DashboardSectionState =
  | { status: "ready"; generatedAt: string }
  | { status: "empty"; generatedAt: string }
  | { status: "stale"; generatedAt: string; staleSince: string }
  | { status: "unavailable"; reasonCode: string }
  | { status: "forbidden" }
  | { status: "error"; retryable: boolean };

interface DashboardOverview {
  schemaVersion: 1;
  organizationId: string;
  range: "7d" | "30d" | "90d";
  generatedAt: string;
  actionQueue: DashboardActionItem[];
  summary: DashboardSummary;
  sections: Record<DashboardSectionId, DashboardSectionState>;
}
```

Requirements:

- authorization and organization scoping happen before aggregation;
- owners/admins may receive financial summary; members receive only availability/limit state;
- return bounded top-N rows and explicit totals, not unbounded collections;
- use server-derived action kinds and resource IDs, never arbitrary hrefs;
- include `generatedAt`, range, scope labels, and versioned schemas;
- cache aggregates by organization, role class, and range with short bounded TTLs;
- poll only urgent counters; refresh analytics manually or on a conservative interval;
- retain independent lazy endpoints for heavy optional widgets;
- a section failure does not fail the whole page and never becomes a false empty state.

### Widget states

Every widget implements: loading, ready, empty, stale, unavailable, forbidden/omitted, partial, and retryable error. “Forbidden” should usually omit the widget without advertising a hidden capability. “Unavailable” explains a configured integration or dependency problem without exposing secrets.

## Personalization

Defaults are persona- and journey-aware:

- new workspace: onboarding, first hunt, source setup;
- recruiter/member: action queue, upcoming, candidates, active work, shortlists;
- owner/admin: team coordination and role-minimized usage warnings in addition;
- verified profile owner: optional claimed-profile summary;
- platform admin: contextual admin attention link only.

Store versioned preferences per user and organization, not only in local storage:

```ts
interface DashboardPreferencesV1 {
  version: 1;
  density: "compact" | "standard";
  range: "7d" | "30d" | "90d";
  order: DashboardWidgetId[];
  hidden: DashboardWidgetId[];
  pinned: DashboardWidgetId[];
}
```

Customization provides Pin/Unpin, Hide/Show, Move up, Move down, and Reset. Drag may be added only with the same keyboard operations. Required widgets cannot be hidden. Unknown or retired widget IDs are ignored safely during migration.

## Accessibility contract

Target WCAG 2.2 AA:

- semantic regions and unique headings identify every widget;
- DOM order, visual order, focus order, and mobile order remain equivalent;
- all controls have visible focus, accessible names, and at least 24 by 24 CSS pixel targets;
- color is never the sole signal; status also uses text and, when helpful, an icon/pattern;
- each visualization has an accessible summary and exact-value table/disclosure;
- SVG marks are not individually focusable unless they perform an action;
- tooltips have keyboard, touch, and non-tooltip equivalents;
- data refresh announces completion through a polite live region only after user action;
- skeletons are not announced as content and respect reduced motion;
- content reflows at 320 CSS pixels and remains usable at 400% zoom;
- forced-colors/high-contrast mode preserves boundaries and status distinctions;
- customization is not drag-only and reports reorder results to assistive technology;
- empty, error, stale, and permission states are understandable without icons or color.

## Security and privacy

- Server-side authorization determines fields, rows, and available actions.
- Dashboard aggregates use the same tenant boundaries as their source domains.
- Organization-admin and platform-admin projections use separate endpoints, contracts, caches,
  preference namespaces, analytics events, and authorization tests.
- No raw candidate email, transcript, private note content, payment detail, provider payload, secret presence beyond an authorized boolean, or viewer identity enters a general widget.
- Minimum-cohort rules apply to privacy-sensitive profile and team aggregates where required.
- Team activity is not an employee-performance score.
- Analytics record widget impressions and continuations only with allowlisted identifiers; never candidate or note content.
- Safe links are assembled through typed route helpers and re-authorized at the destination.

## Performance and reliability budgets

- Render the shell and independent skeleton regions immediately.
- Core overview p95 server time target: <= 500 ms on the representative seeded workspace.
- No default dashboard query returns more than 10 item rows per section or more than 90 daily points.
- Avoid adding a chart library for small bars/lines; use accessible CSS/SVG primitives. If a library becomes necessary, measure bundle cost and audit keyboard/screen-reader behavior first.
- Lazy-load optional lower-page widgets and visualization details without changing layout order.
- A failed optional section must not block critical actions or navigation.

## Success measures

Measure by role and workspace maturity:

- median time from dashboard load to the first valid workflow action;
- percentage of action-queue items continued or resolved;
- preparation started before upcoming interviews;
- review starts from recommendations, alerts, and sprint results;
- saved-search issues opened/resolved after health ships;
- dashboard API and per-section error rates;
- keyboard completion of customization and the five primary continuations;
- zero accessibility regressions in automated and manual dashboard audits;
- zero tenant, role, billing, or privacy-field leakage in contract tests.

These are product-navigation signals, not worker-performance scores. Do not optimize for raw dashboard dwell time.

## Non-goals

- Replacing Calendar, Search, Sprints, Pipeline, Shortlists, Billing, Team Activity, Status, or Admin pages.
- Rendering every product metric on one page.
- Building a general BI/dashboard builder.
- Adding historical claims before historical data exists.
- Making widget order a security boundary.
- Showing operational platform health to ordinary tenant users.
- Mixing platform-admin incidents, abuse, billing operations, or worker controls into the
  organization-scoped `/dashboard` response.
- Implementing Phase 4 saved-search or pipeline domain logic inside the dashboard.

## Definition of done

The dashboard is complete when:

1. its default top section prioritizes real, authorized actions;
2. every widget has a truthful scope, time window, freshness, state, and continuation;
3. visual and keyboard order match at every breakpoint;
4. charts have exact accessible equivalents and make no unsupported claim;
5. role-specific data is filtered on the server;
6. preferences survive device/session changes per user and organization;
7. current misleading metrics are renamed, rebuilt, or removed;
8. dependent widgets remain explicitly unavailable until their canonical domain plans ship;
9. organization admins have a tenant-safe specialized section and platform admins have a separate
   `/admin` Command Center with bounded, redacted, actionable widgets;
10. `/admin/metrics` separates process-local snapshots from persisted history, lazy-loads bounded
    analytical sections, renders conversion with exact cohort evidence, and no longer performs an
    unused billing sweep on frequent refresh;
11. authenticated desktop/mobile E2E, accessibility, contract, isolation, and performance gates pass against representative persona fixtures.
