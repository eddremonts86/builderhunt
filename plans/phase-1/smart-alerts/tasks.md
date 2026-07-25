# Smart Alerts (tasks)

> **Status**: `partially-implemented`
> **Depends on**: nothing (Phase 3 depends on [`ai-expansion`](../ai-expansion/spec.md))
> **Blocks**: nothing hard — see spec.md header
> **Reality check**: Phase 0 is shipped code; only Phases 1–3 below are open work.

## Phase 0 — Delivered (checked, with pointers)

- [x] **Schema: trigger conditions + delivery channel + triggers table**
  - Files: `src/shared/lib/db/schema.ts` (`alerts.triggerConditions`, `alerts.deliveryChannel`, `alertTriggers`)
- [x] **Matcher + trigger recording lib with tests**
  - Files: `src/shared/lib/alerts.ts`, `src/shared/lib/alerts.test.ts` (`evaluateMatch`, `recordTrigger`, `listTriggersForUser`, `markTriggerRead`, `unreadTriggerCount`)
- [x] **Worker: builder-watch + keyword alerts, dedupe, digest emails**
  - Files: `src/lib/alerts/worker.ts` (`runAlertsWorker`), `src/shared/lib/email.ts` (`sendAlertDigestEmail`)
- [x] **Admin HTTP-cron endpoint**
  - Files: `src/routes/api/admin/alerts/run-worker.ts`
- [x] **Alert CRUD API (Pro-gated create, rate-limited) + triggers API + dev test-trigger**
  - Files: `src/routes/api/alerts/index.ts`, `src/routes/api/alerts/triggers/index.ts`, `src/routes/api/alerts/triggers/$id.ts`, `src/routes/api/alerts/test-trigger.ts`
- [x] **Dashboard inbox + create form**
  - Files: `src/routes/_dashboard/alerts.tsx`

## Phase 1 — Frequency honoring + editing

- [ ] **Add `last_checked_at` to alerts**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (generated)
  - Do: Add `lastCheckedAt: timestamp('last_checked_at')` (nullable) to `alerts`; run
    `pnpm db:generate` and `pnpm db:migrate`.
  - Verify: `\d alerts` shows the column; existing rows have NULL.
- [ ] **Frequency window logic in the worker**
  - Files: `src/shared/lib/alerts.ts`, `src/shared/lib/alerts.test.ts`, `src/lib/alerts/worker.ts`
  - Do: Export pure `isDueForCheck(frequency: 'hourly' | 'daily' | 'weekly', lastCheckedAt: Date | null, now: Date): boolean`
    (null → true; windows: hourly always at a ≥ 1 h cron, daily 20 h, weekly 6.5 d).
    Worker: `continue` when not due; otherwise evaluate and then
    `UPDATE alerts SET last_checked_at = now()` regardless of match outcome.
  - Verify: `pnpm test alerts` — new cases: null, inside window, outside window, weekly.
- [ ] **PATCH /api/alerts/$id**
  - Files: `src/routes/api/alerts/$id.ts` (new)
  - Do: Authed, owner-scoped (`and(eq(alerts.id), eq(alerts.userId, session.user.id))`).
    Body zod: partial of `{ enabled: z.boolean(), name: z.string().min(1).max(100), frequency: z.enum(['hourly','daily','weekly']), deliveryChannel: z.enum(['email','dashboard']), triggerConditions: <same object as CreateBody> }`.
    404 when not found/not owner; returns the updated row.
  - Verify: `curl -X PATCH /api/alerts/<id> -d '{"enabled":false}'` → row disabled; other
    user's alert → 404.
- [ ] **Frequency select + pause/edit in the UI**
  - Files: `src/routes/_dashboard/alerts.tsx`
  - Do: Add a frequency `<select>` (hourly/daily/weekly, default daily) to the create form
    body; per-alert row: pause/resume toggle and name/frequency inline edit calling PATCH.
  - Verify: UI check — create a weekly alert, pause it, confirm `GET /api/alerts` reflects
    both; paused alert skipped by a manual `POST /api/admin/alerts/run-worker`.

## Phase 2 — Unread badge

- [ ] **Unread count endpoint**
  - Files: `src/routes/api/alerts/triggers/unread-count.ts` (new)
  - Do: Authed GET returning `{ count }` via `unreadTriggerCount(userId)`
    (`src/shared/lib/alerts.ts`).
  - Verify: curl with a session cookie returns the same count as unread rows in `/alerts`.
- [ ] **Nav badge**
  - Files: `src/routes/_dashboard/route.tsx`
  - Do: Fetch unread count on mount/route change; render a small count pill on the Alerts
    nav link when > 0.
  - Verify: UI check — trigger via `POST /api/alerts/test-trigger`, badge appears; mark
    read in `/alerts`, badge clears on next navigation.

## Phase 3 — Optional AI digest summary (after ai-expansion)

- [ ] **Register `alert-digest-summary` task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: `server-only`; input `{ items: [...] }` (≤ 20, names via `wrapUntrusted`); output
    `z.object({ summary: z.string().min(10).max(300) })`; `cacheTtlSeconds: null`;
    allowances `{ free: 0, pro: 2, team: 2 }`; `maxOutputTokens: 128`.
  - Verify: `pnpm test tasks` registry-integrity cases pass with the new task.
- [ ] **Worker integration (best-effort)**
  - Files: `src/lib/alerts/worker.ts`, `src/shared/lib/email.ts`
  - Do: Before each digest send: budget-check the recipient, call `minimaxChat` through the
    task, pass `summary?` into `sendAlertDigestEmail`/`alertDigestEmailHtml` (renders an
    intro paragraph when present). Wrap in try/catch — failures log and send plain.
  - Verify: With `MINIMAX_API_KEY` set, run-worker produces a digest with a summary line;
    with `AI_DISABLED_TASKS=alert-digest-summary`, digest sends without it and no error.

## Future (not scheduled)

- Real event detection via `unified-timeline` fetchers (new spec revision required).
- `new_product` events once a Product Hunt connector exists.
- Slack/webhook delivery channel (requires a validated Team-tier request).
