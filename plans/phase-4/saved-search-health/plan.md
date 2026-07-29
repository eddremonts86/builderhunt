# Saved Search Health (plan)

> **Status**: `pending`
> **Depends on**: [`smart-alerts`](../../phase-1/34-smart-alerts/plan.md) (`alerts` / `alert_triggers` are the signal source); [`ai-sourcing-sprints`](../../phase-1/41-ai-sourcing-sprints/plan.md) (sprint results count as useful-match evidence). Both already have shipped code — see the reality check.
> **Blocks**: nothing
> **Reality check**: Builds on `src/routes/api/queries/index.ts` (saved-search CRUD), `src/routes/api/alerts/index.ts` + `src/routes/api/alerts/$id.ts` + `src/shared/lib/repositories/organization-alerts.ts` (alerts, `read_at`, and an already-existing `PATCH /api/alerts/$id`), `src/lib/sprints/service.ts` (`createSprint`), `src/modules/dashboard/components/DashboardPage.tsx` (existing saved-searches card) and `src/modules/dashboard/ui/shell/nav-config.ts` (`NAV_AREAS`, the registry the whole shell derives from). `/saved-searches` does not exist yet and is added here; `/alerts` keeps owning alert config + the trigger inbox.

## Phases (dependency order — shippable after each)

### Phase 0 — Attribution foundation (expand-only schema + FK repair)

The prerequisite the original idea missed. Add `sourcing_sprints.saved_query_id` (nullable,
composite tenant FK, index), add the `alert_triggers (organization_id, alert_id, matched_at)`
index, and **re-create both `alerts.query_id` foreign keys as `ON DELETE SET NULL`** — the
composite one with an explicit `(query_id)` column list so deleting a saved query cannot also null
`alerts.organization_id`. Two migrations, because Drizzle can express the action but not the
column list: one generated from `schema.ts`, one `--custom` carrying only the column-scoped
recreation. Then wire the long-dead column: `queryId` accepted on `POST /api/alerts`, on the
**existing** `PATCH /api/alerts/$id` (attach/detach — no new route), and `savedQueryId` accepted on
`POST /api/sprints`. No UI change; attribution starts accumulating immediately so Phase 4 has data.
Shippable: existing behaviour identical, plus saved searches become deletable-with-linked-alerts
instead of 500-ing.

### Phase 1 — Pure health library

`src/shared/lib/saved-search-health.ts` (new): `HEALTH_THRESHOLDS`, `HEALTH_REASONS`,
`REASON_GUIDANCE`, `evaluateSavedSearchHealth(input)` (the 9-rule table, first match wins),
`healthScore`, `sortByHealth`. No I/O, no `db/` imports. Exhaustive test file at
`tests/unit/shared/lib/saved-search-health.test.ts` (new) including every boundary and a
determinism check. Nothing user-visible.

### Phase 2 — Aggregation repository

`src/shared/lib/repositories/saved-search-health.ts` (new): one `withTenantContext`-scoped query
(CTEs: `scoped` → `linked_alerts` → `surfaced` (triggers ∪ sprint results) → `converted`
(identity + tracking join) → per-search aggregates with `FILTER` for the 30-day window) returning
raw counters only, plus the 600 s Redis wrapper keyed `ssh:v1:{organizationId}:{userId}`. Verified
against the real non-owner role, not just the owner, and against
`pnpm security:boundaries` (which mechanically forbids a `/repositories/` file from importing the
global `db`).

### Phase 3 — Read API

`GET /api/saved-searches/health` — `requireTenantPrincipal`, `withTenantContext`, per-row
`can(principal, 'resource:read', { creatorUserId })`, verdicts from Phase 1, DTO allowlist,
`?refresh=1` cache bust, rate limited. Tenant A/B checks added to
`scripts/db/verify-api-isolation-local.mjs`. Still no UI: the feature is curl-verifiable here.

### Phase 4 — `/saved-searches` page

New route `src/routes/_dashboard/saved-searches/index.tsx` (new) + component
`src/modules/dashboard/components/SavedSearchHealthPage.tsx` (new), a `NAV_AREAS` entry **plus**
the matching area route prefix in `src/modules/dashboard/ui/shell/nav-config.ts`, verdict pills,
counters with the "acknowledged, not opened" / "surfaced then tracked" caveat tooltips and the
page-level "RSS reads are not tracked" footnote, staleness line + Refresh, per-verdict actions
(delete / attach alert / run sprint / run search), and the "N need attention" pill on the existing
dashboard card.

### Phase 5 — AI rung + observability polish

Register `saved-search-tune` in `src/shared/lib/ai/tasks.ts` (`local-first`, zod in/out,
`wrapUntrusted` for trigger titles, 24 h cache, `{ free: 0, pro: 50, team: 200 }`), wire the
"Suggest a rewrite" button through `ai()` with the static `REASON_GUIDANCE` fallback, hide it when
`/api/ai/config` reports disabled, add `log.info('saved_search_health_computed', …)` with row
count + duration, and run the full gate (`pnpm lint && pnpm type-check && pnpm test &&
pnpm security:boundaries && pnpm security:route-coverage && pnpm test:api-isolation:local`).

## Risks

| Risk                                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Populating `alerts.query_id` breaks `DELETE /api/queries` (both FKs are `no action` today — `drizzle/0000:261`, `drizzle/0003:17`, unaltered since) | Certain | High | Phase 0 re-creates both FKs as `ON DELETE SET NULL` **before** any code writes the column; task order enforces it; the regression check deletes a linked saved search **as `builderhunt_app`**, since RI-trigger privilege/RLS behaviour is exactly the assumption class this repo has been burned by |
| `ON DELETE SET NULL` on the composite FK nulls `organization_id` too                                      | Medium     | High   | Explicit column list `ON DELETE SET NULL (query_id)` in a `--custom` migration (PostgreSQL ≥ 15; every environment runs `pgvector/pgvector:pg16`); the verification asserts `organization_id` survives a delete |
| The generated snapshot records a *more destructive* FK action than the database has                       | Certain    | Low    | Accepted, documented divergence: drizzle-orm 0.45.2's `UpdateDeleteAction` has no column-list variant. The `--custom` migration carries the reason in a comment directly above the statement, and `schema.ts` carries a matching comment on `organizationQueryFk` so the next regeneration does not silently "fix" it |
| Verdict feels wrong to users and erodes trust                                                            | Medium     | Medium | Every card shows the counters the verdict came from; `unmonitored`/`too-new` refuse to judge; no auto-deletion; thresholds are one exported constant object       |
| "Acknowledged" read as "opened" (bulk `Mark all as read` inflates it)                                    | High       | Medium | Metric labelled "acknowledged" with a tooltip stating the bulk-mark caveat; the word "opened" is banned from the UI; not used in `kill` rules 3/5                 |
| A `hasFeed` flag would have been a fabricated metric                                                     | Certain (avoided) | Medium | Caught in the second adversarial pass: `createFeedCapability` is a stateless HMAC minted for every saved query on every `GET /api/queries`, so `hasFeed` is `true` for 100 % of rows. Replaced by a page-level RSS footnote plus `hasPublicRadar`, which reads a real persisted `public_radars` row |
| Deleting a `kill` row silently kills a public radar page                                                 | Medium     | Medium | `public_radars_organization_query_fk` is `ON DELETE cascade`; `hasPublicRadar` drives an explicit warning in the confirm dialog rather than a silent cascade      |
| `payload->>'sourceId'` extraction is slow or returns nulls for legacy/test triggers                       | Medium     | Low    | New `(organization_id, alert_id, matched_at)` index bounds the scan; null pairs filtered in SQL and excluded from `surfacedIdentities`, never coerced             |
| Nullable `created_at` on `saved_queries`/`alerts` manufactures a false `kill`                            | Low        | Medium | Both columns are `defaultNow()` **without** `.notNull()`; the aggregate coalesces to `now()`, producing `ageDays = 0` → `too-new`, a refusal to judge             |
| Compute-on-read gets slow for a very large tenant                                                        | Low        | Medium | 600 s Redis cache + documented flip trigger (p95 > 500 ms or > 200 saved searches → revisit with a snapshot table); cost proof recorded in spec §3                |
| Health page duplicates `/alerts`                                                                         | Medium     | Low    | Health is read-only aggregate + verdict; alert creation/config and the trigger inbox stay on `/alerts` and are deep-linked, never re-implemented                  |
| New column/column-level access denied to `builderhunt_app` in production                                 | Low        | High   | Grants are table-level so the column inherits (`drizzle/0008:110-118` for `alerts`, `drizzle/0024:55` for `sourcing_sprints`); still proven by `pnpm test:api-isolation:local` against the real non-owner roles (app-reality constraint #7) |
| The nav entry lands in `DashboardLayout.tsx` and does nothing                                            | Medium     | Low    | The shell became registry-driven: `NAV_AREAS` in `nav-config.ts` is the only nav source, and `nav-config.test.ts` fails if a destination's prefix is not owned by its area. The task names both edits |
| AI suggestion misread as the verdict                                                                     | Medium     | Low    | Button is secondary, labelled "Suggested rewrite (AI)", output is copy-to-clipboard keywords only; nothing persisted; verdict recomputed server-side              |

## Rollback

- **Phase 5**: set `saved-search-tune` allowances to `0` for all tiers or
  `AI_DISABLED_TASKS=saved-search-tune`. The button hides; verdicts, metrics and guidance are
  untouched.
- **Phase 4**: delete the route file, the `NAV_AREAS` item + its area route prefix, and the
  dashboard pill. The API stays harmless.
- **Phase 3**: delete the route file. Nothing else reads the repository.
- **Phase 2**: delete the repository module; it is read-only and referenced only by Phase 3.
- **Phase 0** is the only irreversible part, and it is intentionally the safe direction: the FK
  change is strictly more permissive than today, and `sourcing_sprints.saved_query_id` is nullable
  and read by nothing else. To neutralise it without a down-migration, stop sending `queryId`/
  `savedQueryId` from the API layer — the columns go back to being `NULL` for new rows and every
  search reports `unmonitored`. A forward-recovery migration dropping the column and the two
  indexes is trivial if it must go, but the FK repair should be kept regardless: it fixes a real
  latent 500 that `hardDeleteAccountSubject` only dodges for the account-deletion path, never for
  `DELETE /api/queries`.
