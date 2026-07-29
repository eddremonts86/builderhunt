# Plan: Status Page & Trust Signals

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Status page, incidents, changelog, roadmap+votes, admin CMS all
> delivered (see spec). Remaining: uptime-history persistence (small) and an optional
> incident-email phase.

## Phases

### Phase 0 — Delivered (2026-07)

`/status` + `/api/status` deep checks, incidents public+admin, changelog public+admin,
in-house roadmap with voting, `status.ts` lib + tests, footer integration.

### Phase 1 — Uptime history (pre-launch nice-to-have, ~half a day)

`status_checks` snapshot table → `POST /api/admin/status/snapshot` worker (VPS cron, 5 min)
→ uptime computation in `status.ts` (pure function + tests) → surface 30-day % on `/status`.
Missing snapshots count as downtime so a dead server can't report perfect uptime.

### Phase 2 — Incident email subscriptions (optional, post-launch)

`status_subscribers` table + subscribe form on `/status` + send-on-open/resolve hooks in the
admin incident endpoints via `email.ts`. Only build if users actually ask or an incident
demonstrates the need.

## Risks

| Risk                                  | Likelihood | Mitigation                                                                                  |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| Snapshot table grows unbounded        | Low        | Worker prunes rows older than 90 days on each run                                           |
| Cron stops silently → uptime % frozen | Medium     | Missing snapshots count as downtime; page shows "last check {time}" so staleness is visible |
| Self-sampling misses edge outages     | Medium     | Accepted for v1 (documented in spec); gaps in snapshots still register as downtime          |

## Rollback

Phase 1 is additive (new table, new endpoint, extra field on `/api/status` response). Revert
the commit and drop the table; the status page falls back to current behavior.
