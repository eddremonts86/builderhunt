# Activity feed — operational runbook

> Plan: `phase-1/29-activity-feed`. Audience: on-call engineer.

## What this feature is

A denormalized event log of the principal's organization
activity. The product calls it "team activity": a list of who
created / changed / deleted which saved searches, builder
shortlists, alerts, and public feed capabilities. The log is
NOT the security audit log — those are different tables, with
different policies, different retention, and different access
controls.

## Tenant boundary

Every row carries `organization_id` and (nullable) `actor_user_id`.
The principal-scoped repository in
`src/shared/lib/repositories/activity.ts` is the only place
this is enforced. Routes and UI never supply an `organizationId`
parameter to the activity API. The RLS policy on
`organization_activity` is the second line of defense.

`actor_user_id` is **nullable** because some events are
system actions (a public-feed capability mint or revoke has
no human in the loop). A null actor renders as "System" in the
UI. A future schema migration that needs to remove system
events entirely is one ALTER TABLE away.

## Schema

`organization_activity` — see `drizzle/0107_organization_activity.sql`.

- PK: `id uuid` (uuidv7)
- `idempotency_key text UNIQUE` — `(type, organization_id,
  actor_user_id, target_key, day)`. A retry of the same
  logical operation is a no-op.
- `metadata jsonb` — versioned by the registry in
  `src/shared/lib/activity/contracts.ts`. The zod schema for
  each event type is the only thing that can write a row of
  that type; the unknown-keys rejection is at the schema
  level, not at the DB.
- `expires_at timestamp` — set by the registry's
  `retentionDays` at emit time. NULL means "forever".
- CHECK constraint on `type` keeps the registry the only way
  to introduce a new event type.

RLS is forced on. The app role gets SELECT + INSERT scoped by
`app.organization_id`, NO update, NO delete. The worker role
gets SELECT + DELETE for retention. Platform admin gets
SELECT for the operational dashboard.

## Keyset index

`(organization_id, occurred_at DESC, id DESC)` is the only
access path for `listActivity`. The performance test
(`tests/unit/shared/lib/repositories/activity.test.ts`) seeds
10k rows and asserts the query plan uses this index. If a future
migration adds a non-indexed column to the SELECT, run the perf
test before merging.

## Migrations

| Tag | Adds |
| --- | --- |
| `0107_organization_activity` | `organization_activity` + RLS + keyset index + worker delete |

Run on the production DB before code deploy:

```bash
pnpm db:migrate
```

## Tests that gate the feature

| File | Asserts |
| --- | --- |
| `tests/unit/shared/lib/activity/contracts.test.ts` (future) | allowlisted types, canary rejection, versioned metadata |
| `tests/unit/shared/lib/repositories/activity.test.ts` | idempotency, cross-tenant A/B, formatter |
| `tests/unit/security/team-activity-api.test.ts` | route contract, cursor 422, organizationId ignored |
| `tests/unit/shared/lib/workers/activity-retention.test.ts` | bounded deletes, batch size, maxBatches cap, idempotency |
| `tests/unit/shared/lib/repositories/saved-queries.test.ts` | emits `saved_query_*` events on the same tx |
| `tests/unit/shared/lib/repositories/builder-lists.test.ts` | emits `builder_list_*` events on the same tx |
| `tests/unit/shared/lib/repositories/public-feeds.test.ts` | emits `feed_capability_*` events |

The release gate runs `pnpm test:security && pnpm test:rls &&
pnpm test:migrations:local && pnpm lint && pnpm type-check &&
pnpm test && pnpm build`. A failure on any of these blocks
deploy.

## Retention

`runActivityRetention({ now, maxBatches, batchSize, db })`
deletes rows where `expires_at < now` in batches. The default
batch size is 500; the cap is 200 batches (100k rows per run).
A long run that hits the cap returns `hitLimit: true` so the
caller can re-schedule. The worker emits a checkpoint log line
every 5000 rows so a stuck run is visible in the platform
metrics.

The job is scheduled by the operational scheduler (see
`src/shared/lib/workers/`). Schedule at most once per hour.

## Privacy / export

A user requesting their data export will receive the activity
events they ACTED ON (i.e. where `actor_user_id` matches their
id) and the events VISIBLE TO THEM (i.e. their org's events,
filtered by visibility). An org owner requesting a full export
receives the entire `organization_activity` table for their
org. An account deletion (the `account-deletion` workflow)
redacts `actor_user_id` to NULL on the rows that user authored
— the row stays for audit, but the actor is gone. The retention
worker then prunes the row on its normal schedule.

This is a future task. Today, the spec's "owner/member/account
export/deletion matrix" is covered by the existing
`/api/exports/*` endpoints and the `legal.ts` redaction
utilities; the activity-specific export is not yet wired.

## Operational dashboards to add (future)

- `organization_activity.total_rows` per org (anomaly: a single
  org with millions of rows is a write-storm)
- `organization_activity.inserts_per_minute` (a flatline means
  the instrumentation is broken; a spike is a real event)
- `organization_activity.retention_lag_seconds` (the gap
  between the most recent expired row's `expires_at` and the
  most recent delete timestamp)
- `organization_activity.disk_size` (per-tenant)
