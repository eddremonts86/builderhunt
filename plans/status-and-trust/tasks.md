# Tasks: Status Page & Trust Signals

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
> **Reality check**: Status/incidents/changelog/roadmap delivered (checked below).
> Remaining: uptime history (Phase 1) and optional incident emails (Phase 2).

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Schema: `incidents`, `changelog`, `roadmap_items`, `roadmap_votes`** —
      `src/shared/lib/db/schema.ts`, migrated
- [x] **Status logic lib + tests** — `src/shared/lib/status.ts` (`aggregateStatus`, duration
      helpers), `src/shared/lib/status.test.ts` (11 tests)
- [x] **GET /api/status (DB SELECT 1, Redis ping, memory RSS, open incidents)** —
      `src/routes/api/status/index.ts`
- [x] **/status page with 30s polling** — `src/routes/_landing/status.tsx`
- [x] **Public incidents API (last 90 days)** — `src/routes/api/incidents/index.ts`
- [x] **Admin incidents CRUD + UI** — `src/routes/api/admin/incidents/{index,$id}.ts`,
      `src/routes/_dashboard/admin/incidents.tsx`
- [x] **Changelog public pages + API** — `src/routes/changelog.tsx` (layout),
      `src/routes/changelog/{index,$slug}.tsx`, `src/routes/api/changelog/{index,$slug}.ts`
- [x] **Changelog admin CMS** — `src/routes/_dashboard/admin/changelog.tsx`,
      `src/routes/api/admin/changelog/{index,$id}.ts`
- [x] **Roadmap public page with voting (in-house, not Canny)** —
      `src/routes/_landing/roadmap.tsx`, `src/routes/api/roadmap/index.ts`
- [x] **Roadmap admin CRUD** — `src/routes/_dashboard/admin/roadmap.tsx`,
      `src/routes/api/admin/roadmap/{index,$id}.ts`
- [x] **Shallow container health endpoint (deliberate — see file header)** —
      `src/routes/api/health.tsx`
- [x] **Footer links: Status, Changelog, Roadmap** — `src/shared/components/Footer.tsx:52-58`

## Phase 1 — Uptime history

- [ ] **Schema: `status_checks` snapshot table**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (generated migration)
  - Do: `statusChecks` pgTable: `id` text PK, `checkedAt` timestamptz NOT NULL default now,
    `ok` boolean NOT NULL, `components` jsonb (the per-component results array from
    `/api/status`). Index on `checkedAt`.
  - Verify: `pnpm db:generate && pnpm db:migrate` applies cleanly.

- [ ] **Snapshot worker endpoint (HTTP-cron pattern)**
  - Files: `src/routes/api/admin/status/snapshot.ts` (new)
  - Do: POST, auth like `src/routes/api/admin/alerts/run-worker.ts` (mirror its admin/cron
    auth exactly). Runs the same three checks as `api/status/index.ts` (extract them into a
    shared `runStatusChecks()` in `src/shared/lib/status.ts` if needed to avoid duplication),
    inserts one `status_checks` row, deletes rows older than 90 days. Returns
    `{ ok, inserted: true, pruned: n }`. Then add to the VPS crontab:
    `*/5 * * * * curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://builderhunt.dev/api/admin/status/snapshot`
    (documented in the production-infrastructure runbook).
  - Verify: `curl -X POST` inserts a row; unauthorized call is 401/403; repeated calls prune
    old rows.

- [ ] **Uptime computation + display**
  - Files: `src/shared/lib/status.ts`, `src/shared/lib/status.test.ts`,
    `src/routes/api/status/index.ts`, `src/routes/_landing/status.tsx`
  - Do: Pure function `computeUptime(checks: {checkedAt: Date; ok: boolean}[], days: number,
intervalMinutes = 5): number | null` — expected samples = days×24×60/interval; missing
    samples count as down; returns null when < 1 day of data. Tests: all-ok → 100; one gap
    hour → proportional; empty → null. `/api/status` GET adds `uptime30d` (query last 30d of
    `status_checks`); status page renders "30-day uptime: 99.9%" (hidden while null).
  - Verify: `pnpm test status` passes; page shows the number once ≥1 day of cron snapshots
    exists in dev.

## Phase 2 — Incident email subscriptions (OPTIONAL — build only on demonstrated need)

- [ ] **Subscribers table + subscribe endpoint + send hooks**
  - Files: `src/shared/lib/db/schema.ts` (`status_subscribers`: id, email unique, createdAt),
    `src/routes/api/status/subscribe.ts` (new, POST, zod email, rate-limited via
    `src/shared/lib/rate-limit.ts`), `src/routes/api/admin/incidents/index.ts` + `$id.ts`
    (send on create/resolve via `src/shared/lib/email.ts`), `src/routes/_landing/status.tsx`
    (subscribe form)
  - Do: Opt-in list, plain-text emails ("Investigating: {title}" / "Resolved: {title},
    duration {d}"), unsubscribe link (`GET /api/status/subscribe?remove=<id>`), all no-op
    without `RESEND_API_KEY`.
  - Verify: Subscribe → create incident in admin → email received; resolve → second email;
    unsubscribe link removes the row.
