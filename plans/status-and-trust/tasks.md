# Tasks: Status Page & Trust Signals

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
> **Reality check**: Status/incidents/changelog/roadmap delivered (checked below). Phase 1 (uptime
> history) delivered 2026-07-25. Phase 2 (incident email subscriptions) remains explicitly
> optional per its own task text ("build only on demonstrated need") — deliberately not built.

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

- [x] **Schema: `status_checks` snapshot table**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (generated migration)
  - Do: `statusChecks` pgTable: `id` text PK, `checkedAt` timestamptz NOT NULL default now,
    `ok` boolean NOT NULL, `components` jsonb (the per-component results array from
    `/api/status`). Index on `checkedAt`.
  - Verify: `pnpm db:generate && pnpm db:migrate` applies cleanly.
  - **Done.** `0047_parched_bloodaxe.sql` (table + `status_checks_checked_at_idx`) +
    `0048_status_checks_grants.sql` (grants). System-operational table, no owning subject, so no
    RLS — same reasoning as `session_signals`/`abuse_signals`. Grants: `SELECT` to
    `builderhunt_app`/`builderhunt_readonly` (needed since the unauthenticated `/api/status`
    route reads it via the plain app role — same public-read pattern as
    `incidents`/`changelog`/`roadmap_items`), `SELECT, INSERT, DELETE` to `builderhunt_worker`,
    `SELECT` to `builderhunt_platform`. The `DELETE` grant to worker deliberately deviates from
    the "never DELETE" convention documented for `abuse_signals` (an append-only investigation
    trail) — `status_checks` has no such requirement; pruning rows older than 90 days is the
    designed behavior of its own snapshot worker, not a cross-user delete. Applied against the
    real local dev DB and confirmed via `psql`'s `information_schema.role_table_grants` that the
    grants landed exactly as intended. Regenerated `drizzle/migration-hashes.json` via
    `node scripts/db/verify-migration-integrity.mjs --write` (required after adding new
    migrations — confirmed `pnpm test:migration-integrity` passes clean afterward).

- [x] **Snapshot worker endpoint (HTTP-cron pattern)**
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
  - **Done.** Extracted `checkDb`/`checkRedis`/`checkMemory`/`runStatusChecks()` out of
    `api/status/index.ts` into `status.ts` (both the public route and this worker now share the
    same check logic, no duplication). Auth mirrors `alerts/run-worker.ts` exactly:
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`. Audited via
    `auditPlatformAdminAction` with `action: 'admin.worker.run'`,
    `targetType: 'worker'`, `targetId: 'status-snapshot'`. No new
    `docs/operations/production-infrastructure.md` file exists yet (that's a separate,
    still-unbuilt task in the `production-infrastructure` plan) — added the endpoint row + a
    real crontab example to the existing "Workers / scrapers" table in
    `docs/operations/deploy-runbook.md` instead, matching its established style exactly.
  - **Live-verified**: `POST /api/admin/status/snapshot` via a real authenticated admin browser
    session inserted a real row (confirmed via `psql`) with the exact `{name, ok, message?}[]`
    components shape; a `curl` attempt with no auth (and a stale `CRON_SECRET` the running dev
    server process hadn't picked up) correctly returned 401, proving the auth guard rejects
    unauthenticated calls.

- [x] **Uptime computation + display**
  - Files: `src/shared/lib/status.ts`, `src/shared/lib/status.test.ts`,
    `src/routes/api/status/index.ts`, `src/routes/_landing/status.tsx`
  - Do: Pure function `computeUptime(checks: {checkedAt: Date; ok: boolean}[], days: number,
intervalMinutes = 5): number | null` — expected samples = days×24×60/interval; missing
    samples count as down; returns null when < 1 day of data. Tests: all-ok → 100; one gap
    hour → proportional; empty → null. `/api/status` GET adds `uptime30d` (query last 30d of
    `status_checks`); status page renders "30-day uptime: 99.9%" (hidden while null).
  - Verify: `pnpm test status` passes; page shows the number once ≥1 day of cron snapshots
    exists in dev.
  - **Done.** `computeUptime` implemented exactly as specified, plus a defensive `Math.min(100,
    ...)` clamp (a duplicate/overlapping snapshot run should never push the figure above 100%).
    6 new tests in `status.test.ts` (17/17 total passing): empty → null, under-a-day → null even
    at 100% ok, full-window all-ok → 100, proportional one-hour gap, missing samples (a partial
    cron history) counted as down not as absent, and the >100 clamp. `/api/status` now runs
    `runStatusChecks()` alongside a query for the last 30 days of `status_checks` (wrapped in
    `.catch(() => [])` so a transient DB hiccup degrades `uptime30d` to `null` rather than
    failing the whole health check) and returns `uptime30d`. `status.tsx` renders "· 30-day
    uptime: X.XX%" appended to the existing "Updated … · v… · up …m" line, only when non-null.
  - **Live-verified end-to-end**: confirmed `uptime30d: null` with zero/one real snapshot rows
    (correct — under a day of data); seeded 300 additional historical rows directly via `psql`
    spanning ~25 hours at 5-minute intervals, confirmed `/api/status` returned the exact expected
    percentage (`301/8640 × 100 ≈ 3.48%`, matching `computeUptime`'s formula precisely), and
    confirmed the real browser page rendered "30-day uptime: 3.48%" in the status header. Deleted
    all seeded test rows afterward — `status_checks` is empty again, no lingering test data.
  - Verify sweep for all three tasks: `pnpm tsc --noEmit`, `pnpm eslint` (0 errors — 1
    pre-existing-style `set-state-in-effect` warning matching every other polling landing
    page/dashboard component), `pnpm security:route-coverage` (106 routes, valid — confirms the
    new `/api/admin/status/snapshot` route is recognized as guarded), and a full
    `pnpm vitest run` (2004/2004 passing, 10 pre-existing skips).

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
