# Status Page & Trust Signals

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Live today: `/status` (`src/routes/_landing/status.tsx` polling
> `GET /api/status` with db/redis/memory checks), incidents (public `api/incidents` + admin
> CRUD + `/admin/incidents` UI), changelog (public pages + API + admin CMS), roadmap with
> votes (in-house, `roadmap_items`/`roadmap_votes` tables + admin UI), status logic lib
> `src/shared/lib/status.ts` (+ 11 tests), footer links. Missing: uptime _history_ (page shows
> process uptime only) and incident email subscriptions.

## Problem

Users and prospects judge a small product by its transparency. The status/changelog/roadmap
trio is built; what's left is that "uptime" currently means "minutes since last deploy"
(`status.tsx:103` renders `up {status.uptime/60}m` from process uptime) — there is no
persisted check history to compute a real 30/90-day uptime percentage, and nobody is notified
when an incident opens.

## Goal

Persist health snapshots so `/status` can show honest 30/90-day uptime, and (optionally,
phase 2) notify subscribers by email on incident open/resolve.

## Non-goals

- No Canny/UptimeRobot/PagerDuty — the in-house roadmap and incidents already replaced them.
- No WebSockets — 30s client polling is shipped and sufficient.
- No auto-detection of incidents from error spikes (manual admin flow works; revisit
  post-launch if incidents are ever noticed late).
- No per-component historical graphs — one overall uptime number + incident list is enough.
- No public status API for third parties.

## Delivered (audited 2026-07-19)

- **Status page**: `src/routes/_landing/status.tsx` — overall banner, component list, recent
  incidents, 30s auto-refresh; data from `GET /api/status`
  (`src/routes/api/status/index.ts`: real DB `SELECT 1`, Redis ping when configured, memory
  RSS check).
- **Status logic lib**: `src/shared/lib/status.ts` (`aggregateStatus`, incident duration
  helpers) with 11 tests in `status.test.ts`.
- **Incidents**: `incidents` table; public `GET /api/incidents`; admin
  `POST /api/admin/incidents` + `PATCH /api/admin/incidents/$id` (status/severity/resolve);
  admin UI `src/routes/_dashboard/admin/incidents.tsx`.
- **Changelog**: `changelog` table; public `/changelog` + `/changelog/$slug`
  (`src/routes/changelog/` + layout `changelog.tsx`); APIs `api/changelog/*`; admin CMS
  `admin/changelog.tsx` + `api/admin/changelog/*`.
- **Roadmap (in-house, not Canny)**: `roadmap_items` + `roadmap_votes` tables; public
  `/_landing/roadmap.tsx` with voting via `api/roadmap`; admin `admin/roadmap.tsx` +
  `api/admin/roadmap/*`.
- **Health endpoint**: `src/routes/api/health.tsx` — intentionally shallow (no DB touch) for
  container healthchecks; the deep checks live in `/api/status`. This split is deliberate
  (documented in the file header) — do not "fix" it.
- **Footer**: Status/Changelog/Roadmap links (`src/shared/components/Footer.tsx:52-58`).

## Remaining work (each gap cited)

1. **Uptime history**: no `status_checks` table exists (`schema.ts`), and `/status` shows
   process uptime, not availability (`status.tsx:103`). Add a snapshot table written by an
   HTTP-cron worker (`/api/admin/status/snapshot`, VPS cron every 5 min — same pattern as
   `api/admin/alerts/run-worker.ts` per `_meta/app-reality.md` constraint 3) and compute
   30/90-day uptime from it.
2. **Incident email subscriptions (optional phase)**: no `status_subscribers` table, and the
   admin incident endpoints send no email (grep `resend|sendEmail` in
   `src/routes/api/admin/incidents/` → nothing). Small opt-in email list via existing
   `email.ts`. Deferred — nice-to-have, not launch-blocking.

## Success metrics

- `/status` shows a 30-day uptime % computed from ≥7 days of real snapshots before launch.
- Incident open→resolved lifecycle updates the page within one poll interval (30s) — already
  true, keep it that way.
- (Phase 2) incident emails delivered to subscribers within 5 minutes of open/resolve.

## Resolved questions

- Roadmap tooling: in-house shipped — Canny question is closed.
- Uptime source: self-sampled via cron snapshots (an external pinger only sees the edge; the
  worker records the same component checks users see, and an edge outage shows up as a
  missing-snapshot gap, which counts as downtime in the computation).
