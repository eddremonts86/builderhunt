# Smart Alerts (spec)

> **Status**: `partially-implemented`
> **Depends on**: nothing (Phase AI is optional and depends on [`ai-expansion`](../ai-expansion/spec.md))
> **Blocks**: nothing hard — [`activity-feed`](../activity-feed/spec.md) instruments
> `recordTrigger` in `src/shared/lib/alerts.ts` when it lands; the future "real event
> detection" phase would consume [`unified-timeline`](../unified-timeline/spec.md) fetchers.
> **Reality check**: The core of this plan is SHIPPED. `alerts` + `alert_triggers` tables
> exist (`src/shared/lib/db/schema.ts`), the matcher/recording lib is `src/shared/lib/alerts.ts`
> (+ `alerts.test.ts`), the worker is `src/lib/alerts/worker.ts` behind
> `POST /api/admin/alerts/run-worker`, CRUD is `src/routes/api/alerts/`, the inbox UI is
> `src/routes/_dashboard/alerts.tsx`, digests go out via `sendAlertDigestEmail`
> (`src/shared/lib/email.ts`, Resend with dev-console fallback). What remains: honoring
> `frequency`, an edit/pause endpoint, an unread badge, and honest event-type semantics.

## Problem

Static keyword alerts are noisy and badly timed. Recruiters want to be notified when
something _happens_ — a tracked builder becomes active again, a new profile matching their
criteria appears — without reloading profiles daily.

## Goal

An event-driven alert system: users define alerts with trigger conditions (event type,
follower/star thresholds, keywords, optional single-builder watch), a background worker
evaluates them on a cron cadence, matches are recorded as triggers (dashboard inbox) and
delivered as consolidated email digests.

## Non-goals

- No instant push/SMS. Email digests + dashboard inbox only.
- No scraping beyond the public APIs the search pipeline already uses.
- No per-event webhooks (future, if teams ask for Slack).

## Delivered (v1 — do not re-plan)

| Piece                                                                                                                                                                                                                                                                                  | Where                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Schema: `alerts.triggerConditions` jsonb (`eventType`, `minStars`, `minFollowers`, `keywords`, `builderId`), `alerts.deliveryChannel` (`email`\|`dashboard`), `alerts.frequency` (`hourly`\|`daily`\|`weekly`), `alert_triggers` (payload jsonb, `matchedAt`, `readAt`)                | `src/shared/lib/db/schema.ts`                                        |
| Pure matcher `evaluateMatch(conditions, builder, event)` + `recordTrigger`, `listTriggersForUser`, `markTriggerRead`, `unreadTriggerCount`                                                                                                                                             | `src/shared/lib/alerts.ts`, tests in `tests/unit/shared/lib/alerts.test.ts` |
| Worker `runAlertsWorker()`: builder-watch alerts re-check the saved builder's `lastSeen` vs `lastTriggeredAt`; keyword alerts re-run `searchBuilders()` and dedupe against prior triggers by `payload.sourceId`; ≤ 5 new triggers per alert per run; one digest email per user per run | `src/lib/alerts/worker.ts`                                           |
| Admin-gated HTTP-cron endpoint (the pattern every other plan clones)                                                                                                                                                                                                                   | `src/routes/api/admin/alerts/run-worker.ts`                          |
| CRUD: `GET`/`POST`/`DELETE /api/alerts` (create is rate-limited 20/day and Pro-gated with a 402 + `/pricing` upsell), `GET /api/alerts/triggers`, `PATCH /api/alerts/triggers/$id` (mark read), dev-only `POST /api/alerts/test-trigger`                                               | `src/routes/api/alerts/`                                             |
| Dashboard inbox + create form                                                                                                                                                                                                                                                          | `src/routes/_dashboard/alerts.tsx`                                   |
| Digest email (Resend, dev-mode console fallback)                                                                                                                                                                                                                                       | `src/shared/lib/email.ts#sendAlertDigestEmail`                       |
| Billing: "Smart alerts" listed under Pro in `PLAN_PRICING`, enforced at create time                                                                                                                                                                                                    | `src/shared/lib/billing-shared.ts`, `src/routes/api/alerts/index.ts` |

## Honest v1 semantics (documented, not a bug)

The `eventType` values (`new_repo`, `new_product`, `keyword_match`, `any_activity`) are
**match labels, not detected events**. The worker has no per-builder activity stream:

- Builder-watch alerts fire on "`lastSeen` advanced since last trigger" — i.e. "this
  builder showed up in search results again", not "pushed a repo".
- Keyword alerts fire on _new profiles_ matching the search, deduped per alert.
- `new_product` is effectively dead until a Product Hunt connector exists
  ([`producthunt-integration`](../producthunt-integration/spec.md) is still planned).

Real event detection (actual new repos, new posts) requires per-builder activity fetching —
that is exactly what [`unified-timeline`](../unified-timeline/spec.md) builds. Wiring the
worker to those fetchers is a **Future** phase here, deliberately not scheduled until
unified-timeline ships.

## Remaining gaps (the actual scope of this plan now)

1. **`frequency` is stored but ignored.** The worker evaluates every enabled alert on every
   run (cron cadence 12 h). Keyword alerts hit external APIs via `searchBuilders`, so this
   wastes quota and makes `weekly` meaningless. Fix: add `alerts.lastCheckedAt`; the worker
   skips alerts whose `lastCheckedAt` is younger than the frequency window (hourly → always,
   daily → 20 h, weekly → 6.5 d) and stamps it after evaluation. Expose frequency in the
   create form (the API already accepts it; the UI never sends it).
2. **No edit/pause.** Alerts can only be created and deleted. Add
   `PATCH /api/alerts/$id` (`enabled`, `name`, `frequency`, `deliveryChannel`,
   `triggerConditions`) + a pause toggle in the UI.
3. **Unread badge.** `unreadTriggerCount()` exists in `src/shared/lib/alerts.ts` and is
   called by nothing. Expose it (`GET /api/alerts/triggers/unread-count`) and badge the
   Alerts nav item in the dashboard shell.
4. **Optional AI digest summary** (Phase AI, per `_meta/ai-policy.md`) — see below.

## AI task (optional phase, not core)

**`alert-digest-summary`** — a 1–2 sentence TL;DR at the top of the digest email
("3 new Rust builders matched 'async runtime'; @foo you watch is active again").

- **Tier policy**: `server-only` (background — the worker has no browser; policy rule 2).
- **Input schema**: `{ items: Array<{ alertName, username, displayName?, source, eventType }> }`
  (≤ 20 items; external display names pass through `wrapUntrusted`).
- **Output schema**: `z.object({ summary: z.string().min(10).max(300) })`.
- **Cache TTL**: none (`null`) — digests are unique per run.
- **Allowances**: worker-invoked, not user-invoked — budgeted per _recipient_:
  `{ free: 0, pro: 2, team: 2 }` per day (alerts are Pro-gated anyway; free is 0 by
  construction). Consumed via the platform budget helper with the recipient's userId.
- **maxOutputTokens**: 128.
- **Fallback**: any AI failure/disable → send the digest exactly as today, no summary line.
  `AI_DISABLED` and missing `MINIMAX_API_KEY` short-circuit before any call.
- **Cost**: ≤ (users emailed per run) calls × ~400 input / 128 output tokens, 2 runs/day.
  At 100 Pro users with daily matches: ~200 calls/day ≈ trivial MiniMax spend, absorbed by
  the Pro tier that gates alerts.

## Success metrics

- Digest emails contain only new matches (no repeats) — verified by the `payload.sourceId`
  dedupe already in place.
- After the frequency fix: external API calls from the worker drop for daily/weekly alerts
  (observable in `alerts_worker_run` log lines: `alertsEvaluated` < total enabled alerts).
- Unread badge count matches inbox state.

## Resolved edge cases

- **Alert with empty keywords and no builderId**: worker `continue`s (already handled).
- **Resend down**: digest send failure is recorded in `result.errors`, triggers remain in
  the dashboard inbox — nothing lost.
- **Free user with pre-existing alerts** (created before gating, or downgraded): worker
  still evaluates them; gating is create-time only. Documented, acceptable.
- **Worker double-run** (two cron hits): dedupe by `payload.sourceId` per alert makes the
  second run a near-no-op; ≤ 5 triggers/alert caps blast radius.
