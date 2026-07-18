# Plan: Team Activity Feed

**Status:** Not yet implemented. **Depends on [`team-accounts`](../team-accounts/plan.md)**
(and pairs naturally with [`shared-resources`](../shared-resources/plan.md), though it
doesn't strictly require it).

## Goal recap

Give teams a lightweight, chronological feed of what teammates have been doing —
new searches, new builders saved, notes added, alerts firing — so the "Activity feed"
line item in the Team pricing tier (`billing-shared.ts`) is a real, working feature.

## Why this is a valuable addition

1. **Coordination without meetings.** A team sourcing candidates for the same role
   needs to know "has anyone already looked at this person?" without a standup.
2. **Makes the Team plan feel alive, not just a permissions wrapper.** Seats and
   sharing (`team-accounts`, `shared-resources`) are necessary but invisible
   infrastructure; a feed is the one Team-only surface a buyer actually *sees* and
   can screenshot for a sales conversation.
3. **Cheap to build relative to its visibility.** Unlike `semantic-search` or
   `work-sample` (both LLM-backed, higher-risk), this is a straightforward
   event-log-and-render feature with no external API dependency.

## Current-state constraints this plan must work around

- No event/audit-log table exists anywhere in the schema today — this is new
  surface area, not an extension of an existing one.
- The mutation endpoints this needs to instrument are spread across several route
  files (`/api/queries`, `/api/builders/$builderId/notes`, alert-trigger creation) —
  there's no existing single choke point to hook into.

## Phases

### Phase 1: Schema
- Add `activity_events`: `id`, `organizationId`, `actorUserId`, `type` (e.g.
  `'search_created' | 'search_shared' | 'builder_saved' | 'note_added' |
  'alert_triggered' | 'member_joined'`), `targetType`, `targetId`, `metadata`
  (`jsonb`, e.g. `{ searchName, builderUsername }` for a readable feed line without
  extra joins), `createdAt`.
- Index on `(organizationId, createdAt desc)` — the only query pattern this table
  serves is "latest events for my org, paginated".

### Phase 2: Event emission
- A single `logActivity(orgId, actorUserId, type, target, metadata)` helper in
  `src/shared/lib/activity.ts`, called **best-effort / fire-and-forget** (wrapped in
  try/catch, never blocking or failing the primary action) from:
  - `saved_queries` create/share (from `shared-resources`)
  - `builder_notes` create
  - `builder_list_items` add (from `shared-resources`)
  - `alert_triggers` insert (the existing smart-alerts trigger path)
  - `organization_members` join (from `team-accounts`)
- Only fires when `organizationId` is present — personal accounts never write to
  this table at all.

### Phase 3: API
- `GET /api/org/activity?cursor=&type=` — paginated, optionally filtered by event
  type, scoped strictly to the caller's `organizationId` (never client-suppliable).

### Phase 4: UI
- A feed view (dashboard widget for Team accounts, plus a dedicated `/team/activity`
  page for full history) — grouped by day, each row: actor avatar, verb, link to the
  target (builder profile or saved search).
- Empty state for a brand-new org ("No activity yet — invite your team and start a
  hunt.") rather than a blank page.

### Phase 5: Verification
- Ordering + pagination correctness.
- An event never appears in another org's feed (same isolation bar as
  `shared-resources`).
- Personal (non-team) accounts see no feed route/widget at all, and generate zero
  `activity_events` rows — confirms the fire-and-forget hook is truly a no-op when
  `organizationId` is null.
- Table growth: define and test a retention job (e.g. prune events older than 180
  days) so this doesn't become an unbounded table.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Unbounded table growth** | Medium | Low | Retention/pruning job from day one (Phase 5), not bolted on after the table is already large. |
| **Noisy feed teams stop reading** | Medium | Low | Ship with a small, deliberate set of event types (listed in Phase 1) rather than logging every possible mutation; add more only on request. |
| **Cross-org leakage** | Low | Critical | Same server-side `organizationId` scoping discipline as `shared-resources`; covered by an explicit isolation test. |

## Rollback plan

- Every write is gated on `organizationId != null` and wrapped in try/catch — deleting
  the `activity_events` table and removing the `logActivity()` call sites (or just
  no-op-ing the helper) fully rolls this back with no impact on the actions it
  observes, since it never sits in the critical path of those actions.
