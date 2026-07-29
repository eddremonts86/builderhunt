# Smart Alerts (tasks)

> **Status**: `implemented` (Phase 3's worker/email.ts integration sub-task skipped — see note)
> **Depends on**: nothing (Phase 3 depends on [`ai-expansion`](../21-ai-expansion/spec.md))
> **Blocks**: nothing hard — see spec.md header
> **Reality check (updated 2026-07-29)**: Phases 0–2 shipped and live-verified. Phase 3's task
> registration shipped; only the worker/`email.ts` wiring is open. It was skipped because `email.ts`
> was a reserved file *for one past session* — that restriction was never a property of this plan and
> does not apply now. The task carries its own Files/Do/Verify. **It is executable.**

## Phase 0 — Delivered (checked, with pointers)

- [x] **Schema: trigger conditions + delivery channel + triggers table**
  - Files: `src/shared/lib/db/schema.ts` (`alerts.triggerConditions`, `alerts.deliveryChannel`, `alertTriggers`)
- [x] **Matcher + trigger recording lib with tests**
  - Files: `src/shared/lib/alerts.ts`, `tests/unit/shared/lib/alerts.test.ts` (`evaluateMatch`, `recordTrigger`, `listTriggersForUser`, `markTriggerRead`, `unreadTriggerCount`)
- [x] **Worker: builder-watch + keyword alerts, dedupe, digest emails**
  - Files: `src/lib/alerts/worker.ts` (`runAlertsWorker`), `src/shared/lib/email.ts` (`sendAlertDigestEmail`)
- [x] **Admin HTTP-cron endpoint**
  - Files: `src/routes/api/admin/alerts/run-worker.ts`
- [x] **Alert CRUD API (Pro-gated create, rate-limited) + triggers API + dev test-trigger**
  - Files: `src/routes/api/alerts/index.ts`, `src/routes/api/alerts/triggers/index.ts`, `src/routes/api/alerts/triggers/$id.ts`, `src/routes/api/alerts/test-trigger.ts`
- [x] **Dashboard inbox + create form**
  - Files: `src/routes/_dashboard/alerts.tsx`

## Phase 1 — Frequency honoring + editing

- [x] **Add `last_checked_at` to alerts**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0055_fuzzy_ben_urich.sql`
  - Did: Added `lastCheckedAt: timestamp('last_checked_at')` (nullable) to `alerts`.
  - Verified: migration applied locally; column present, existing rows NULL.
- [x] **Frequency window logic in the worker**
  - Files: `src/shared/lib/alerts.ts` (`isDueForCheck`, `FREQUENCY_WINDOW_MS`),
    `tests/unit/shared/lib/alerts.test.ts`, `src/lib/alerts/worker.ts`,
    `src/shared/lib/repositories/alerts-worker.ts` (`markWorkerAlertChecked`)
  - Did: `isDueForCheck('hourly'|'daily'|'weekly', lastCheckedAt, now)` — null → true;
    windows: hourly 55 min, daily 20 h, weekly 6.5 d (each slightly under nominal to absorb
    cron jitter). Worker `continue`s past not-due alerts; a `finally` block marks every
    evaluated alert checked regardless of match outcome.
  - **Bug found + fixed during live verification**: the worker's `builderhunt_worker` DB
    role only had a column-scoped `UPDATE (last_triggered_at)` grant on `alerts`
    (0010_worker_alert_policies.sql) — the new `last_checked_at` column had no grant, so
    every `markWorkerAlertChecked` write failed with `permission denied for table alerts`
    (RLS policy allowed the row, the column-grant didn't). Fixed with
    `drizzle/0056_alerts_last_checked_grant.sql` (`GRANT UPDATE (last_checked_at) ...`).
  - Verified: `pnpm vitest run alerts.test.ts` (8 new cases: null/inside/outside window ×
    hourly/daily/weekly + boundary); live `POST /api/admin/alerts/run-worker` (Bearer
    `CRON_SECRET`) — first call evaluated both real alerts and set `last_checked_at`;
    immediate second call returned `alertsEvaluated: 0` (correctly skipped, not due yet).
- [x] **PATCH /api/alerts/$id**
  - Files: `src/routes/api/alerts/$id.ts` (new), `src/shared/lib/repositories/organization-alerts.ts`
    (`updateOrganizationAlert`)
  - Did: Authed via `requireTenantPrincipal` + `withTenantContext`, organization-scoped
    (matches this codebase's tenant convention, not a raw `session.user.id` check — same
    pattern as the existing DELETE handler in `api/alerts/index.ts`). Body zod: partial of
    `{ enabled, name, frequency, deliveryChannel, triggerConditions }`. 404 when not
    found/not this org's alert.
  - Verified live in browser: toggled "Php alert" enabled→false (UI showed "Paused"),
    PATCH'd `frequency` hourly→weekly via the per-row select, confirmed via
    `read_network_requests` response body (`"frequency":"hourly"` then back to `"weekly"`).
- [x] **Frequency select + pause/edit in the UI**
  - Files: `src/routes/_dashboard/alerts.tsx`
  - Did: Frequency select was already present on the create form; added a per-alert-row
    pause/resume `Button` (`toggleAlertEnabled`, PATCH `{enabled}`) and a per-row frequency
    `Select` (`updateAlertFrequency`, PATCH `{frequency}`).
  - Verified: live browser click-through (pause → "Paused" badge appears; frequency select
    → PATCH fires, response confirms new value; resumed + restored to original state after).

## Phase 2 — Unread badge

- [x] **Unread count endpoint**
  - Files: `src/routes/api/alerts/triggers/unread-count.ts` (new)
  - Did: Authed GET returning `{ count }` via `unreadOrganizationTriggerCount`.
  - Verified: live in browser via `read_network_requests` — matches the "N unread" count
    already shown in the inbox header.
- [x] **Nav badge**
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx` (not `_dashboard/route.tsx`
    — the topbar nav pills live in `DashboardLayout`, per this session's earlier
    dashboard-redesign work; `route.tsx` only mounts the shell)
  - Did: Fetch unread count on mount + route change (`location.pathname` dep); render a
    small accent-colored count pill on the Alerts `NavPill` (desktop) and the mobile
    hamburger-sheet row, "9+" past 9.
  - Verified: live in browser — badge rendered on `/alerts` while triggers were unread.

## Phase 3 — Optional AI digest summary (after ai-expansion)

- [x] **Register `alert-digest-summary` task**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Did: `server-only`; input `{ items: [{alertName, username, source, eventType}] }`
    (1–20, wrapped via `wrapUntrusted`); output `{ summary: string (10-300 chars) }`;
    `cacheTtlSeconds: null`; allowances `{ free: 0, pro: 2, team: 2 }`;
    `maxOutputTokens: 128`.
  - Verified: `pnpm vitest run tasks.test.ts` — dedicated registry test + the generic
    registry-integrity checks all pass.
- [ ] **Worker integration (best-effort)** — **skipped this session**
  - Files: `src/lib/alerts/worker.ts`, `src/shared/lib/email.ts`
  - Do: In the worker, before sending a digest, budget-check the recipient; call the registered AI
    digest task; pass its result into `sendAlertDigestEmail` as the optional `summary` argument; wrap
    the whole call in try/catch so any failure falls back to the plain digest rather than dropping
    the email. The task itself is already registered — this only wires the worker to it.
  - Verify: `pnpm vitest run tests/unit/lib/alerts` passes with a case that asserts the plain digest
    still sends when the AI task throws, and one that asserts `summary` reaches
    `sendAlertDigestEmail` when it resolves. Then trigger the worker route locally and confirm one
    email lands in the dev outbox with the summary block present.
  - Why still open: `src/shared/lib/email.ts` was a reserved file when this was written. Nothing
    calls the digest task today, so there is no half-finished behavior in production — leaving it
    unwired indefinitely is safe.

## Future (not scheduled)

- Real event detection via `unified-timeline` fetchers (new spec revision required).
- `new_product` events once a Product Hunt connector exists.
- Slack/webhook delivery channel (requires a validated Team-tier request).
