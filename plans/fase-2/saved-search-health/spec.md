# Saved Search Health (spec)

> **Status**: `pending`
> **Depends on**: [`smart-alerts`](../../smart-alerts/spec.md) (`alerts` / `alert_triggers` are the signal source); [`ai-sourcing-sprints`](../../ai-sourcing-sprints/spec.md) (sprint results count as useful-match evidence). Both already have shipped code — see the reality check.
> **Blocks**: nothing
> **Reality check**: `saved_queries`, `alerts`, `alert_triggers`, `sourcing_sprints`, `sprint_results` all exist in `src/shared/lib/db/schema.ts`; saved searches are created/listed/deleted by `src/routes/api/queries/index.ts` and rendered as a Bento card (`SavedSearchRow`) inside `src/modules/dashboard/components/DashboardPage.tsx`. **There is no `/saved-searches` route** — `src/routes/_dashboard/` contains `alerts.tsx`, `search/`, `sprints/`, `exports/`, `dashboard/`, `me/`, `settings/`, `admin/` only. `/alerts` (`src/routes/_dashboard/alerts.tsx`) already owns alert configuration + the trigger inbox and must not be duplicated.

## Problem

A user accumulates saved searches (Pro limit: 50, Team: 200 — `PLAN_LIMITS` in
`src/shared/lib/billing-shared.ts`) and alerts on top of them, and nothing ever says which still
work. `src/lib/alerts/worker.ts` fires forever; a search whose keywords went stale keeps generating
noise, and a search that quietly stopped matching looks identical to one that was never good. The
workspace rots and the user either ignores every alert or abandons the feature.

## Goal

One read-only page — `/saved-searches` — showing, per saved search, a small set of **honestly
computable** numbers and a single **deterministic verdict**: `healthy`, `tune-query`, `kill`, plus
two "cannot judge yet" states (`unmonitored`, `too-new`). A weekly two-minute triage.

## Non-goals

- **No new table.** No health-snapshot table, no history, no trend line, no weekly worker
  (see "Weekly job vs compute-on-read").
- **No LLM verdict.** The verdict is a pure function. AI appears only as an optional,
  additive "suggested keyword rewrite" rung that never changes the verdict.
- **No cross-member roll-up.** An owner/admin does not get to see a colleague's saved-search
  health; org-visible saved searches are owned by [`shared-resources`](../../shared-resources/spec.md)
  (`blocked`).
- **No automatic deletion**, no auto-pausing of alerts. Every destructive action stays a click.
- **No backfill** of the attribution columns Phase 0 starts populating. Pre-existing alerts and
  sprints stay unattributed and are reported as `unmonitored`, never as failure.
- **No email-open pixel and no RSS hit counter.** See "What is not measurable".

## The "cero schema nuevo" claim — RESOLVED: it is false, but only barely

Verified against `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/organization-alerts.ts`,
`src/shared/lib/repositories/saved-queries.ts`, `src/lib/alerts/worker.ts` and
`src/lib/sprints/service.ts`:

| Claimed input                       | Reality today                                                                                                                                                                            | Verdict                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| "alerts fired" per saved search      | `alerts.query_id` exists (+ composite tenant FK `alerts_organization_query_fk`) but **is written by nothing**: `CreateBody` in `src/routes/api/alerts/index.ts` has no `queryId`, and `CreateOrganizationAlertInput` has no `queryId` field. Grep for `queryId` outside `schema.ts` returns zero hits. | Dead column. Needs **wiring, no new column**.        |
| "alerts you opened"                  | `alert_triggers.read_at` exists **and is written** — `PATCH /api/alerts/triggers/$id` → `markOrganizationTriggerRead`, driven by the "Mark as read" button in `src/routes/_dashboard/alerts.tsx`.                                                                                                     | Available, but it means *acknowledged*, not opened. |
| "% of results you interacted with"   | `organization_builders` has no reference to the search that surfaced the builder. `alert_triggers.builder_id` is `NULL` for every keyword alert (the common case — `worker.ts` passes `builderId: null`), but `payload.source` / `payload.sourceId` **are** always written.                            | Computable via a join, with a stated caveat.        |
| sprint results as evidence           | `sourcing_sprints` has `criteria` / `variants` (derived from a pasted job description) and **no `saved_query_id`**. Sprints are created by `createSprint` in `src/lib/sprints/service.ts` from `createSprintSchema`.                                                                                    | Needs **one new nullable column**.                  |

**Minimum honest addition (all expand-only, zero new tables):**

1. Wire the existing `alerts.query_id`: add `queryId?: string` to `CreateBody` and to
   `CreateOrganizationAlertInput`, plus `PATCH /api/alerts` to attach/detach an existing alert.
2. **Latent bug this activates**: both FKs on `alerts.query_id`
   (`alerts_query_id_saved_queries_id_fk` from `drizzle/0000`, `alerts_organization_query_fk` from
   `drizzle/0003`) are `ON DELETE NO ACTION`. Today that is harmless because the column is always
   `NULL`; the moment it is populated, `deleteSavedQuery` starts failing with an FK violation
   (a 500 from `DELETE /api/queries`). Phase 0 must re-create both as `ON DELETE SET NULL`, the
   composite one with an explicit column list (`ON DELETE SET NULL (query_id)`) so the delete does
   **not** also null out `organization_id`. Requires PostgreSQL ≥ 15; production runs
   `pgvector/pgvector:pg16`. The action itself goes into `schema.ts` (drizzle-orm 0.45.2's
   `UpdateDeleteAction` includes `'set null'`); the **column list cannot be expressed in Drizzle**,
   so that one detail stays a documented, commented divergence between the snapshot and the
   database — see the migration task in tasks.md.
3. New nullable `sourcing_sprints.saved_query_id text` + composite tenant FK
   `(organization_id, saved_query_id) → saved_queries(organization_id, id) ON DELETE SET NULL
   (saved_query_id)` + index `(organization_id, saved_query_id)`. Populated by one entry point:
   "Run a sourcing sprint from this search" on the health page.
4. Supporting index `alert_triggers (organization_id, alert_id, matched_at DESC)` —
   `alert_triggers` has only `(organization_id, id)` today, and the aggregate filters on
   `alert_id` + `matched_at`.

Data classes are unchanged: `saved_queries` / `alerts` / `alert_triggers` / `sourcing_sprints` /
`sprint_results` are all **tenant private** (`organization_id`) and already carry RLS + FORCE RLS
(`drizzle/0008_tenant_rls.sql`, `drizzle/0024_sourcing_sprints_grants.sql`). Grants are table-level
(`GRANT … ON TABLE`), so the new column inherits them — no new policy or grant migration is needed,
but the isolation suite must still prove it (see "Multi-tenancy").

## What is not measurable — stated, not faked

- **Alert email opens / click-throughs**: no tracking pixel, no click wrapper in
  `src/shared/lib/email.ts`. Not reported at all.
- **"Alerts you opened"**: `read_at` is a manual in-app acknowledgement and `Mark all as read` in
  `alerts.tsx` bulk-sets it. Ships labelled **"acknowledged"** with that caveat in the tooltip;
  the word "opened" never appears in the UI.
- **RSS consumption**: `/api/feeds/$searchId.xml` records nothing (`public-feeds.ts` has no write
  path), so an RSS-only search looks dead. The card shows "RSS activity not tracked" when a feed
  token exists. A counter is out of scope.
- **Causality**: a surfaced builder may have been found elsewhere. The metric is a time-ordered
  co-occurrence, labelled exactly that: *"surfaced, then tracked"*.

## Architecture

### 1. Metrics (per saved search, all computed in one SQL round trip)

Window: `WINDOW_DAYS = 30`, ending `now`.

- `linkedAlertCount` / `enabledAlertCount` — `alerts` where `query_id = savedQuery.id`.
- `triggersFired` — `alert_triggers` of those alerts, `matched_at` in window;
  `triggersAcknowledged` — of those, `read_at IS NOT NULL`; `lastTriggerAt` — all-time max.
- `surfacedIdentities` — distinct `(source, sourceId)` surfaced in window by either evidence
  source: **A** trigger `payload->>'source'` / `payload->>'sourceId'`, **B** `sprint_results` of
  sprints whose `saved_query_id` is this search.
- `usefulMatches` — of those, the ones joining an `organization_builders` row (via
  `builder_identities` on `(source, source_id)`) with `status IN ('tracked','shortlisted')` and
  `created_at >= surfaced_at - INTERVAL '1 day'` (grace for worker/clock ordering).
  `lastUsefulMatchAt` — same join, **all-time**, max tracked-at.
- `conversionRate` = `usefulMatches / surfacedIdentities` (null when nothing was surfaced) — the
  honest version of "% of results you interacted with".

### 2. The verdict — pure, deterministic, tested

`src/shared/lib/saved-search-health.ts` (no I/O, no imports from `db/`):

```ts
export type SavedSearchVerdict = "unmonitored" | "too-new" | "healthy" | "tune-query" | "kill";

export interface SavedSearchHealthInput {
  ageDays: number; // floor((now - createdAt) / 1 day)
  linkedAlertCount: number;
  triggersFired: number; // window
  triggersAcknowledged: number; // window, subset of triggersFired
  usefulMatches: number; // window
  surfacedIdentities: number; // window
  daysSinceLastTrigger: number | null; // null = never fired
  daysSinceLastUsefulMatch: number | null; // null = never, ALL-TIME
}

export interface SavedSearchHealth {
  verdict: SavedSearchVerdict;
  reason: SavedSearchHealthReason;
  score: number | null; // 0–100; null for unmonitored + too-new
  conversionRate: number | null;
  acknowledgeRate: number | null;
}

export const HEALTH_THRESHOLDS = {
  WINDOW_DAYS: 30,
  MIN_AGE_DAYS: 14, // below this: too-new
  DEAD_AGE_DAYS: 60, // above this, with zero all-time usefulness: kill
  NOISE_FLOOR: 20, // triggers in window that count as "a lot"
  LOW_ACK_RATE: 0.2,
  USEFUL_TARGET: 3, // usefulMatches that saturate the score's conversion term
  RECENCY_HALF_LIFE_DAYS: 60,
} as const;
```

**Rules, evaluated top to bottom, first match wins — that is the entire tie-break policy:**

| # | Condition                                                                             | Verdict       | Reason                   |
| - | ------------------------------------------------------------------------------------- | ------------- | ------------------------ |
| 1 | `linkedAlertCount === 0`                                                              | `unmonitored` | `no_linked_alert`        |
| 2 | `ageDays < MIN_AGE_DAYS`                                                              | `too-new`     | `too_new`                |
| 3 | `triggersFired === 0 && daysSinceLastUsefulMatch === null && ageDays >= DEAD_AGE_DAYS` | `kill`        | `no_signal_ever`         |
| 4 | `triggersFired === 0`                                                                 | `tune-query`  | `no_matches_in_window`   |
| 5 | `usefulMatches === 0 && daysSinceLastUsefulMatch === null && ageDays >= DEAD_AGE_DAYS` | `kill`        | `fires_but_never_useful` |
| 6 | `usefulMatches === 0 && triggersFired >= NOISE_FLOOR`                                 | `tune-query`  | `noisy_no_conversion`    |
| 7 | `usefulMatches === 0`                                                                 | `tune-query`  | `no_conversion`          |
| 8 | `triggersFired >= NOISE_FLOOR && acknowledgeRate < LOW_ACK_RATE`                       | `tune-query`  | `ignored_volume`         |
| 9 | otherwise                                                                             | `healthy`     | `converting`             |

`acknowledgeRate = triggersFired === 0 ? null : triggersAcknowledged / triggersFired`
(rule 8 treats `null` as not-matching). Comparisons are non-strict on the threshold side
(`ageDays >= 14` is *not* too-new; `triggersFired === 20` *does* hit the noise floor;
`acknowledgeRate === 0.2` is *not* `ignored_volume`).

**Score** (display + list ordering only, never the verdict), `null` for `unmonitored`/`too-new`:

```
score = round(40 * min(1, usefulMatches / USEFUL_TARGET)
            + 30 * min(1, (acknowledgeRate ?? 0) / 0.5)
            + 30 * recency)
recency = daysSinceLastUsefulMatch !== null
  ? max(0, 1 - daysSinceLastUsefulMatch / 60)
  : daysSinceLastTrigger !== null ? 0.25 * max(0, 1 - daysSinceLastTrigger / 30) : 0
```

`sortByHealth(rows)` — worst first: `score` ascending with `null` last, then
`daysSinceLastTrigger` ascending with `null` last, then `name` (locale-independent `<`),
then `id`. Fully deterministic and stable.

### 3. Weekly job vs compute-on-read — RESOLVED: compute-on-read

**Compute-on-read with a 10-minute Redis cache. No worker, no snapshot table.** Rejected
alternative: a `/api/admin/saved-search-health/run-worker` writing a
`saved_query_health_snapshots` table — it buys only a trend line and costs a new tenant-private
table (+ RLS + grants + isolation tests), a cron, and a staleness problem, for a page whose whole
computation is three indexed aggregates.

Cost proof for the worst realistic tenant (50 saved searches, 5 000 lifetime triggers,
2 000 tracked builders):

| Step                                       | Access path                                                                               | Rows touched  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------- |
| saved searches                             | `saved_queries_organization_id_id_unique` prefix scan on `organization_id`                 | 50            |
| alerts grouped by `query_id`               | `alerts_organization_id_id_unique` prefix scan                                            | ≤ 200         |
| triggers of linked alerts                  | **new** `alert_triggers (organization_id, alert_id, matched_at DESC)`                      | ≤ 5 000       |
| sprint results of linked sprints           | `sprint_results_sprint_created_idx` + **new** `sourcing_sprints (organization_id, saved_query_id)` | ≤ 2 000 |
| identity resolution                        | `builder_identities_source_source_id_unique` index probe, one per surfaced pair            | ≤ 7 000 probes |
| tracking resolution                        | `organization_builders_org_identity_unique` index probe                                   | ≤ 7 000 probes |

≈ 14 k index probes, well under 250 ms uncached; cached 600 s at
`ssh:v1:{organizationId}:{userId}` via `getRedis()` (same pattern as `src/lib/search.ts`), Redis
absence tolerated. Flip trigger, recorded in plan.md's risks: p95 > 500 ms or > 200 saved searches
in one organization ⇒ revisit with a snapshot table. Staleness shows as `computedAt`
("updated 4 min ago") with a Refresh button that busts the key.

### 4. Read surface

`GET /api/saved-searches/health` → `{ computedAt, windowDays, rows: SavedSearchHealthRow[] }`.

```ts
interface SavedSearchHealthRow {
  id: string;
  name: string;
  keywords: string[];
  sources: string[];
  createdAt: string;
  hasFeed: boolean; // RSS exists -> "RSS activity not tracked" note
  metrics: {
    linkedAlertCount: number; enabledAlertCount: number;
    triggersFired: number; triggersAcknowledged: number;
    surfacedIdentities: number; usefulMatches: number;
    lastTriggerAt: string | null; lastUsefulMatchAt: string | null;
  };
  health: SavedSearchHealth; // verdict, reason, score, rates
  guidance: string; // static copy from REASON_GUIDANCE, always present
}
```

DTO allowlist only (no ORM rows, no trigger payloads, no builder identities) per
`security-policy.md` §10.

### 5. Optional AI rung — `saved-search-tune` (additive, never the verdict)

Shown only on `tune-query` / `kill` rows, behind an explicit "Suggest a rewrite" button.

- **Tier**: `local-first` — interactive, ephemeral, this-user-only, nothing persisted
  (`ai-policy.md` decision rule). Chrome AI first, `/api/ai/complete` (MiniMax M3) fallback.
- **Input** `z.object({ name, keywords: z.array(z.string()).min(1).max(12), sources: z.array(z.string()), language: z.string().nullable(), country: z.string().nullable(), reason: z.enum(HEALTH_REASONS), triggersFired: z.number().int(), usefulMatches: z.number().int(), sampleTitles: z.array(z.string().max(200)).max(5) })`.
  `sampleTitles` come from `alert_triggers.payload.name` — **external content**, wrapped in
  `wrapUntrusted(...)` inside `buildPrompt`.
- **Output** `z.object({ keywords: z.array(z.string().min(1)).min(1).max(8), remove: z.array(z.string()).max(8), rationale: z.string().min(1).max(240) })`.
- `cacheTtlSeconds: 86400`, `allowances: { free: 0, pro: 50, team: 200 }`, `maxOutputTokens: 500`
  (MiniMax M3 emits a `<think>` block — see the `ping` task's comment in `tasks.ts`).
- **Degradation ladder**: Chrome AI → MiniMax proxy → the static `REASON_GUIDANCE[reason]` string
  (always rendered anyway) → button hidden entirely when `/api/ai/config` reports disabled.
  The verdict, the metrics and the guidance text never depend on AI.

## UX integration

- **New route** `src/routes/_dashboard/saved-searches/index.tsx` + component
  `src/modules/dashboard/components/SavedSearchHealthPage.tsx`; new nav item ("Saved searches",
  `Bookmark`) in `src/modules/dashboard/ui/shell/DashboardLayout.tsx` between Search and Sprints.
- One card per search, ordered by `sortByHealth`: name + keywords, verdict pill (`kill` danger /
  `tune-query` warning / `healthy` success / `unmonitored`+`too-new` neutral), the four counters
  with caveat tooltips, the guidance line.
- Per-verdict primary action: `kill` → Delete (`DELETE /api/queries`, confirm dialog);
  `tune-query` → Suggest a rewrite (AI rung) + Run a sprint from this search (`POST /api/sprints`
  with `savedQueryId`); `unmonitored` → Attach an alert (`PATCH /api/alerts`, or an upgrade hint on
  free — alerts need `entitlement.paidActionsAllowed`); `healthy` → Run search.
- `DashboardPage.tsx`'s saved-searches card gets a "N need attention" pill linking here. `/alerts`
  is untouched and deep-linked for the trigger inbox.

## Tier / billing gating

The page and the verdict are **free for every tier** — telling a free user their search is dead is
retention, not a paid feature. Only the AI rung is gated (`allowances.free = 0` + upgrade hint).
No checkout or credit path is involved: entitlements resolve exactly as `POST /api/sprints` does
(`getOrganizationEntitlement` + `resolveLegacyPlanTier`), so with `STRIPE_BILLING_ENABLED=false`
the page behaves identically — free users just see `unmonitored` everywhere until they upgrade and
can create an alert.

## Cost model (AI rung only)

An active Pro user triages weekly across ~5 unhealthy searches and asks for a rewrite on 1–2 →
≤ 10 calls/user/week, 24 h cache (repeat clicks free). ≥ 70 % expected on Chrome AI (zero cost);
MiniMax absorbs the rest at ~600 prompt + ≤ 500 output tokens. Free tier: zero server spend.

## Multi-tenancy

- **Scope**: `WHERE organization_id = principal.organizationId AND user_id = principal.userId`.
  `saved_queries` has **no `visibility` column**, so `can(principal, 'resource:read',
  { creatorUserId: row.userId })` in `src/shared/lib/authorization/permissions.ts` can only ever
  return true for the creator — an owner/admin gains nothing, deliberately. The route calls `can()`
  per row before emitting a DTO rather than inferring from the query.
- **Deliberately stricter than `/api/queries`**: that route runs `executeTenantRead(modes.read, …)`
  where `legacy` filters `(userId, organizationId)` and `canonical` filters `organizationId` only,
  and `TENANT_READ_MODE` defaults to `legacy`. Health always uses the `(organizationId, userId)`
  filter — the strictest of the two — so it can never show a colleague's searches in either mode.
  Widening it is `shared-resources`' job.
- Every query runs inside `withTenantContext(principal, tx => …)` from a repository module
  (`src/shared/lib/repositories/saved-search-health.ts`) that never imports the global `db`.
- Threat cases proven by extending `scripts/db/verify-api-isolation-local.mjs`
  (`pnpm test:api-isolation:local`): unauthenticated; no active organization; A's session vs B's
  saved-query id in the `?savedQueryId=` selector (404, no existence leak); B's triggers absent
  from A's counters; B's sprint results absent from A's `usefulMatches`; attaching A's alert to B's
  saved query rejected; `builderhunt_app` direct SQL without RLS context returns zero rows.

## Success metrics

- ≥ 30 % of searches first shown as `kill` are deleted or retuned within 7 days.
- Saved searches per active organization stop growing monotonically (net deletions > 0/month).
- `GET /api/saved-searches/health` p95 < 250 ms for a 50-search / 5 000-trigger organization.
- ≥ 90 % of alerts created after Phase 0 carry a non-null `query_id`.
- Zero rows where the UI shows a verdict the pure function did not produce (the API never
  computes a verdict outside `saved-search-health.ts`).

## Resolved edge cases

- **Free tier**: cannot create alerts (`paidActionsAllowed`), so every search is `unmonitored`.
  The card shows "Alerts are a Pro feature" instead of the attach action — never a `kill` verdict
  a free user cannot act on.
- **Alert attached today, search 6 months old**: `linkedAlertCount > 0` but `ageDays >= 60` with
  no history. Rule 3 would say `kill`. Mitigation: `ageDays` is
  `min(daysSince(savedQuery.createdAt), daysSince(oldest linked alert.createdAt))` — the
  observation window cannot precede the first alert. Stated in the pure function's contract and
  unit-tested.
- **Search deleted while an alert points at it**: fixed by the `ON DELETE SET NULL (query_id)`
  migration; the alert survives, orphaned, and shows up on `/alerts` unchanged.
- **Trigger payload missing `source`/`sourceId`** (hand-made rows via
  `POST /api/alerts/test-trigger`, which takes a free-form payload): those triggers count toward
  `triggersFired` but contribute no `surfacedIdentities`. Nulls are filtered in SQL, never coerced.
- **Same identity surfaced by two searches**: counted for both. Attribution is intentionally
  non-exclusive; the metric answers "did this search surface something useful", not "who gets credit".
- **Sprint linked to a search after the fact**: only `sprint_results` rows already stored count,
  and only inside the window — no retroactive claim, no backfill.
- **Redis unavailable**: every request recomputes. The cost proof above is the uncached cost.
- **`AI_DISABLED=true`**: the AI button disappears; verdicts, metrics and guidance are unchanged.
