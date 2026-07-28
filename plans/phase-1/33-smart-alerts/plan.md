# Smart Alerts (plan)

> **Status**: `partially-implemented`
> **Depends on**: nothing (Phase 3 is optional and depends on [`ai-expansion`](../20-ai-expansion/spec.md))
> **Blocks**: nothing hard — see spec.md header
> **Reality check**: Core shipped (schema, `src/shared/lib/alerts.ts`,
> `src/lib/alerts/worker.ts`, `/api/alerts` CRUD, `/alerts` page,
> `/api/admin/alerts/run-worker`, Resend digests). This plan covers only the remaining gaps.

## Phases

### Phase 0 — Delivered (record only)

Everything in spec.md's "Delivered" table. No work. Kept as the record per
`_meta/conventions.md` rule 2.

### Phase 1 — Frequency honoring + alert editing (ships alone)

1. Migration: add `alerts.last_checked_at timestamp` (nullable).
2. Worker: skip alerts checked within their frequency window; stamp `lastCheckedAt` after
   evaluation (success or failure). Pure window function `isDueForCheck(frequency,
lastCheckedAt, now)` exported and unit-tested.
3. `PATCH /api/alerts/$id`: partial update (`enabled`, `name`, `frequency`,
   `deliveryChannel`, `triggerConditions`), owner-scoped, zod-validated.
4. UI: frequency select in the create form; pause/resume toggle + edit affordance per alert
   row in `src/routes/_dashboard/alerts.tsx`.

Checkpoint: fully shippable — worker cheaper, alerts manageable.

### Phase 2 — Unread badge (ships alone)

1. `GET /api/alerts/triggers/unread-count` (authed, cheap count via existing
   `unreadTriggerCount`).
2. Badge on the Alerts nav item in the dashboard shell (`src/routes/_dashboard/route.tsx`);
   refetch on route change; clears as triggers are marked read.

### Phase 3 — Optional AI digest summary (requires ai-expansion Phases 1–3)

1. Register `alert-digest-summary` in `src/shared/lib/ai/tasks.ts` (schema/tier/allowances
   per spec.md).
2. Worker calls `minimaxChat` via the task (per-recipient budget check) right before
   `sendAlertDigestEmail`; on any error, sends the digest unchanged.
3. Digest HTML gains an optional summary paragraph.

### Future (explicitly unscheduled)

- Real event detection (`new_repo` as an actual repo-creation event) consuming
  [`unified-timeline`](../32-unified-timeline/spec.md) fetchers.
- `new_product` semantics once [`producthunt-integration`](../17-producthunt-integration/spec.md) exists.
- Slack/webhook delivery channel for teams.

## Risks

| Risk                                                           | Likelihood | Impact | Mitigation                                                                                                              |
| -------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Frequency skip logic silently starves alerts (bad window math) | Low        | Medium | Pure `isDueForCheck` with unit tests for all three frequencies + null `lastCheckedAt`                                   |
| PATCH allows condition edits that orphan dedupe history        | Low        | Low    | Dedupe is per-alert by `payload.sourceId`; editing keywords just widens/narrows future matches — acceptable, documented |
| AI summary delays or breaks digest sends                       | Low        | High   | Summary is strictly best-effort: `try/catch` around the task call, digest always sends                                  |
| External API quota from keyword alerts                         | Medium     | Medium | Already mitigated (worker uses cached `searchBuilders`, ≤ 5 triggers/alert); Phase 1 reduces call volume further        |

## Rollback plan

- Phase 1: `last_checked_at` is additive; reverting the worker change restores current
  behavior with no data loss. PATCH endpoint can be deleted independently.
- Phase 2: badge is UI-only.
- Phase 3: covered by the platform kill switch (`AI_DISABLED` /
  `AI_DISABLED_TASKS=alert-digest-summary`) — digests revert to plain form instantly.
