# UI Coverage and Navigation Completion — Delivery Plan

> **Status**: `pending`
> **Depends on**: the implemented portions of [`shared-resources`](../phase-1/28-shared-resources/spec.md), [`activity-feed`](../phase-1/29-activity-feed/spec.md), [`status-and-trust`](../phase-1/47-status-and-trust/spec.md), [`calendar-scheduling-interview-intelligence`](../phase-1/44-calendar-scheduling-interview-intelligence/spec.md), and [`stealth-scraping`](../phase-1/42-stealth-scraping/spec.md)
> **Blocks**: nothing
> **Reality check**: Routes and most feature components already exist. Delivery starts with route integrity and core-journey connections, then completes missing user surfaces, and only then adds operator consoles.

## Delivery principles

1. Fix dead ends before adding destinations.
2. Reuse existing domain APIs and authorization.
3. Keep one canonical route per capability.
4. Add operator actions only after a read-only projection exists.
5. Never expose a control the current role cannot successfully use.
6. Keep every wave independently shippable and reversible.
7. Verify with the disposable E2E harness, not the broken shared admin fixture.
8. Treat client links, server-generated email URLs, structured metadata, robots policy, and
   projection links as one first-party route contract.
9. A visible health/capability claim must be backed by a real checked endpoint or tested export.

## Wave 0 — Restore authenticated UI verification

Repair the local admin fixture to use the intended privileged/auth database connection during seed,
or add a documented harness command that mints a platform-admin fixture and opens an authenticated
browser session. This is test infrastructure, not production authorization.

Exit criteria:

- a real browser reaches `/dashboard` and `/admin/metrics`;
- the session survives reload;
- the fixture does not grant ownership to the runtime app role;
- no credential or connection string appears in output.

## Wave 1 — Route integrity and navigation registry

Update `NAV_AREAS`:

- add Shortlists under Pipeline;
- add Team activity under Workspace;
- add Operations, Integrations, and Claims under Admin when their routes ship;
- keep route prefixes and destination items synchronized.

Remove obsolete or type-bypassed navigation:

- `/dashboard/lists` → `/lists`;
- `/_dashboard/lists` → `/lists`;
- `/_dashboard/lists/$listId` → `/lists/$listId`;
- authenticated alert builder link `/builders/$builderId` → `/builder/$builderId` when the ID is
  an organization-builder ID.
- Team Activity back route `/_dashboard` → `/dashboard`;
- calendar alert projection `/dashboard/alerts` → `/alerts`;
- operational projection API anchors → `/admin/operations?job=…`;
- privacy email `/dashboard/settings/privacy` → `/settings/privacy`.

Add a route-graph test that fails when:

- an internal `to` or first-party `href` points to no generated full path;
- a first-party URL emitted by email, structured metadata, projection DTOs, or redirects points to
  no generated route;
- a dashboard route ID leaks into a browser URL;
- a registered navigation destination is missing from the generated tree;
- a non-contextual authenticated leaf route has no owning navigation area.

Replace the `/dashboard/`-only robots assumptions with an explicit policy for every authenticated
top-level route. Add entity-aware breadcrumbs for builder, shortlist, sprint, interview, live
interview, and admin detail routes, using safe parent labels when entity data is unavailable.

Create one exhaustive source-presentation registry typed from `SOURCE_NAMES`. It owns label, icon,
badge, safe external URL construction, tracking availability, and dormant reason for Search,
Recommendations, Builder Profile, Exports, and result cards. No source may fall back to `#`.

Exit criteria:

- Shortlists and Team activity are reachable in desktop and mobile navigation;
- no known obsolete path remains;
- every navigation registry integrity test passes.

## Wave 2 — Make the builder workspace the journey hub

Create one shared result action contract used by Search, Recommendations, Alerts, Sprints,
Shortlists, and Exports:

- tracked result: `Open workspace` → `/builder/$builderId`;
- untracked result: `Track & open` → POST `/api/builders/track`, then navigate using returned `id`;
- secondary `Open source profile` → safe external URL;
- plan-limit failure → show upgrade action without losing the result;
- unsupported tracking source → keep external action and explain why internal tools are unavailable.

Add safe origin continuity:

- allow `from=/search?...`, `/alerts`, `/sprints/:id`, or `/lists/:id`;
- validate same-origin app paths with the existing safe-next policy;
- render a contextual back action on the builder workspace;
- do not persist arbitrary referrers or external URLs.

Make shortlist and export rows open the builder workspace. Add explicit `Search builders` and
`Back to shortlists` actions to empty/detail states.

Add shortlist metadata management:

- authorized rename and description editing;
- private/organization visibility update with a consequence warning;
- optimistic version handling and activity event;
- creator/non-creator permission states.

Upgrade Team Activity to use server-derived, allowlisted `actorDisplayName` and `targetHref`.
List/search/alert events navigate to their resource when it still exists and is authorized; deleted
or inaccessible targets remain non-clickable without disclosing why.

Exit criteria:

- the same result has consistent actions in all six surfaces;
- a user can move Search → Builder → Shortlist → Builder without losing context;
- external profiles remain one click away but are not the only continuation.
- shortlist metadata and activity navigation respect creator/organization permissions.

## Wave 3 — Complete Calendar UI

Split the current monolithic `CalendarPage.tsx` into the Phase 1 component boundary:

- `CalendarView.tsx`: FullCalendar month/week/day/list views, today/date navigation, range query,
  drag/resize, rollback;
- `CalendarAgenda.tsx`: accessible narrow-screen agenda;
- `EventEditor.tsx`: complete create/edit form;
- `EventDetails.tsx`: details, edit, cancel/delete, join/open interview;
- `AvailabilityEditor.tsx`: versioned weekly policy, overrides, timezone and defaults;
- `CalendarNotifications.tsx`: paginated drawer, unread count, mark read, event navigation.

Add view/search state to validated route search params. Add bounded ICS export. Preserve the
existing projection layers and details panel.

The event editor covers:

- timed/all-day;
- title, notes, location, meeting URL;
- timezone and busy/free;
- participants;
- recurrence and exception scope;
- reminder channels and offsets;
- overlap warning;
- optimistic version conflicts.

Complete the connected scheduling/interview workflow:

- add an Invitations destination with draft/sent/opened/booked/declined/revoked filters;
- resume, preview, send, and revoke draft invitations after reload;
- link booked rows to Calendar, builder workspace, brief, and live interview;
- replace cancel-then-book with the atomic public reschedule endpoint, keeping the existing booking
  when the requested slot conflicts;
- reconcile the scheduling/interview API registry with cancel, decline, reschedule, and participant
  permission endpoints;
- add an owner-only participant panel to grant/revoke brief, report, and transcript access
  separately from attendance;
- add a tenant-safe `Shared with me` interview projection and list for users with material grants.

Exit criteria:

- behavior matches “Complete calendar behavior” in Phase 1 plan 44;
- desktop and 320 px flows work;
- calendar APIs have a corresponding UI consumer;
- drafts survive refresh, rescheduling is atomic, and shared interviews are discoverable only by
  authorized recipients;
- interview material grants are explicit, audited, revocable, and never inferred from attendance;
- no private candidate detail leaks into notification or projection summaries.

## Wave 4 — Complete claimant and public trust surfaces

### Claimed-profile data controls

Add a `Public data and provenance` section under `/me` for each verified claim:

- load the allowlisted provenance projection;
- show source, field categories, observation date, and retention state;
- never expose tenant, recruiter, reviewer, note, or match-score metadata;
- offer `Restrict automated processing` with clear consequences and confirmation;
- render restricted, pending, success, and idempotent repeat states;
- link to public Privacy and Removal pages.

### Status subscription

Add a real email subscription form to `/status` using `/api/status/subscribe`:

- email validation;
- pending, success, rate-limit, and generic error states;
- anti-enumerating success copy;
- unsubscribe result handling;
- no claim that subscription exists when email delivery is unavailable.

Render every server-returned health check, including memory, and remove hard-coded Search/API “OK”
rows. Add a real backend check before those components can reappear. A degraded overall status must
always identify at least one visible degraded/unknown check. Route unsubscribe links through a
human-readable `/status` result state while preserving uniform anti-enumerating behavior.

### Owner profile analytics

Record eligible internal/public profile views through the existing consent-aware endpoint. Add a
verified-owner panel under `/me` showing total and a 30-day daily aggregate chart, with minimum
cohort handling and no viewer identity, organization, query, or referrer.

### Admin claims

Add `/admin/claims`:

- bounded list/search/filter projection;
- claim status and source proof;
- portfolio publication indicator;
- detail drawer;
- revoke confirmation with reason;
- link to the public profile/portfolio when published;
- immutable audit result.

Exit criteria:

- every shipped claim/restriction/profile-view/status endpoint has a usable and truthful surface;
- platform-admin and verified-claimant boundaries are covered by negative E2E cases.

## Wave 5 — Operator operations and integration health

### Operations

Add `/admin/operations` backed by a new redacted projection:

- one row per `OPERATIONAL_SCHEDULES` entry;
- enabled state, cadence, timezone, next run;
- last completed/failed/running record;
- duration, counters, redacted error code;
- stale/overdue detection;
- pause/resume;
- guarded manual run through a server-owned allowlist;
- refresh and filters.

Do not render raw job payloads, candidate data, source URLs, tokens, or stack traces.

### Integrations and AI

Add `/admin/integrations`:

- search sources typed from `SOURCE_NAMES`, never a hand-maintained duplicate;
- enabled/dark/dormant state;
- credential configured boolean, never value;
- last success/failure and quota where the connector exposes it;
- discovery, embedding, enrichment, and Devpost indexed/backlog counts;
- AI global/task kill-switch state, provider availability, budget errors, and task version;
- deep links to Operations, Metrics, Search filtered by source, and the relevant runbook.

This page is observability, not secret management.

### Billing operator actions

Extend `/admin/billing`:

- reconciliation run and latest result;
- dead-letter event lookup and replay;
- bounded webhook/dead-letter event list and detail, so a failed event is discoverable without
  already knowing its ID;
- risk-exception list/create/expire;
- worker run;
- bounded accounting export download;
- direct links to Refunds and Disputes;
- step-up confirmation and audit feedback for mutations.

### Metrics

Consume `/api/admin/metrics/conversion` from `/admin/metrics` and show the bounded conversion
funnel, retention window, and insufficient-data state. Add redacted removal-request counts by
state/source and aging from the trust audit; never include subject identity or request content.

Reframe Admin Users plan controls as audited manual grants/exceptions. Show the owning organization
and canonical entitlement, include Pro Max, and link to Billing Operations; do not imply that the
page edits Stripe-owned per-user subscriptions.

Exit criteria:

- every registered worker is observable;
- every state-changing control is allowlisted, confirmed, authorized, idempotent, and audited;
- no secrets or raw external payloads reach the browser.
- failed billing events can be found before replay, and legacy grants cannot obscure canonical
  organization billing state.

## Wave 6 — Public navigation and contextual cross-links

Replace the public header's home-anchor-only model with responsive navigation:

- Product: Explore, Pricing;
- Learn: Blog, Changelog, Roadmap;
- Trust: Status, Security;
- home-page section anchors remain available on Home;
- mobile drawer exposes the same route set;
- current route is visibly and accessibly active.

Add contextual cross-links:

- Status incident → admin incident when the viewer is a platform admin;
- Admin content item → public preview;
- public builder profile ↔ published portfolio;
- portfolio owner preview → Account settings;
- booked invitation → Calendar and Interview;
- Calendar interview event → Brief/Live workspace;
- locked paid feature → Billing settings plus public Pricing details.

Reconcile export product truth:

- preferred delivery: an Export Center with explicit scope (all tracked builders, one shortlist,
  saved-search results, or note collection), CSV/JSON format, permission explanation, bounded
  generation, progress/error state, and internal builder links in prior exports;
- immediate safety: until each scope/format ships, remove it from Home copy, FAQ, structured
  metadata, and any other public claim.

Exit criteria:

- no important public route is footer-only;
- public and authenticated shells do not nest or duplicate navigation;
- all links use safe generated paths.
- every advertised export scope/format produces a real authorized download, and no unimplemented
  export is advertised.

## Wave 7 — Optional portfolio adapters and honest Solutions state

Implement the two already-approved open plan 37 adapters:

- opt-in AI persona section;
- opt-in public timeline section.

Both parse existing versioned artifacts, omit invalid/stale/absent data, and never trigger AI from
an anonymous request.

For Solutions:

- immediately label the current route as demo/preview while plan 43 is incomplete;
- display prerequisite readiness from server-owned feature flags;
- remove any production-success wording from demo output;
- once plan 43 ships, bind the existing brief/interpretation/charge/result steps to the real
  endpoints rather than creating a second UI.

Exit criteria:

- public portfolios expose only owner-selected data;
- Solutions never misrepresents fixture lanes as generated production results.

## Wave 8 — Accessibility, responsive, visual, and journey gates

Add E2E journeys:

1. Search → track and open → shortlist → shortlist detail → builder.
2. Recommendation → track and open.
3. Alert match → track and open.
4. Sprint result → track and open.
5. Calendar availability → event create/edit/move/recur/export → notification.
6. Candidate booking → atomic reschedule conflict/success → organizer invitation hub → Calendar.
7. Interview owner grants material access → recipient discovers Shared with me → owner revokes.
8. Shortlist edit → activity target → builder workspace; export row → builder workspace.
9. Verified claimant → provenance → profile analytics → restrict processing.
10. Public status real degraded check → subscribe → incident mail fixture → unsubscribe.
11. Platform admin → claims revoke.
12. Platform admin → operations manual run/pause/resume.
13. Platform admin → billing failed-event discovery → replay.
14. Platform admin → integration health → worker detail.
15. Export Center scope/format download and public-copy truth check.
16. Public mobile header → every product/trust route.

Run keyboard and axe checks on every new dialog, drawer, menu, form, and table. Add visual snapshots
for the calendar views, mobile agenda, operations table, integrations grid, claims page, status
form, and public mobile navigation.

Final gate:

```bash
pnpm plans:check-tasks
pnpm type-check
pnpm lint
pnpm test
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
node scripts/check-ui-route-graph.mjs
pnpm build
pnpm ci:local
```

Run the core journey suite twice consecutively.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Route registry grows too large | Preserve area/group hierarchy; validate ownership and mobile rendering. |
| Tracking just to open a workspace changes data | Label the action `Track & open`; never silently track from a plain external-link click. |
| Calendar bundle and state complexity regress performance | Lazy-load calendar modules and FullCalendar plugins; fetch bounded ranges only. |
| Admin operations become a remote shell | Use fixed action enums and server-owned route allowlists; no arbitrary URLs or arguments. |
| Integration page leaks configuration | Return booleans/redacted identifiers only; schema-test the DTO. |
| Status subscription enables enumeration | Preserve the existing uniform response and rate limit. |
| Status UI masks a failing check | Render the server check set exhaustively; reject unmeasured hard-coded health rows. |
| Claim controls leak cross-tenant facts | Use platform role only for admin projection and existing verified-subject authorization for `/me`. |
| Interview sharing leaks sensitive artifacts | Separate attendance from each material grant; add negative tenant and revoked-access tests. |
| Reschedule destroys the current booking | Call the atomic endpoint and keep the previous booking on every failed replacement. |
| Export marketing outruns implementation | Gate public/structured claims on tested scope-format capabilities. |
| Demo Solutions is mistaken for production | Persistent preview badge, prerequisite state, and no unqualified success copy. |
| Public header becomes crowded | Use Product/Learn/Trust groupings and a single mobile drawer. |

## Rollback

- Navigation items can be removed independently without deleting routes.
- New pages are additive; existing APIs remain unchanged unless a new projection is required.
- Calendar can temporarily fall back to the current month view behind a UI feature flag while the
  existing APIs remain canonical.
- Manual operator actions can be disabled independently while retaining read-only operations and
  integration pages.
- Portfolio adapters are opt-in and can be disabled without affecting core publication.
- Public header can revert to the current compact layout without changing public routes.
