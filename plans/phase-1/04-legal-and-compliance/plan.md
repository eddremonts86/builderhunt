# Plan: Legal & Compliance

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Docs, consent, export, and deletion-request flows are delivered (see
> spec). All three phases are done as of 2026-07-21: deletion executes via
> `processPendingDeletions()` + `POST /api/admin/legal/run-worker`, the export payload is
> complete, the hard-delete cascade covers builder notes/alerts/saved queries/builders,
> lifecycle emails send through the existing free-tier Resend integration (no new paid
> service), and the ops checklist (processor audit, real imprint details, DMCA disclosure)
> is done. Still needs a daily VPS cron wired to the worker endpoint (non-code, infra task).

## Phases

### Phase 0 — Delivered (2026-07)

Legal pages, cookie banner, TOS re-acceptance modal, consent API, synchronous data export
with throttle+expiry, deletion request/cancel with 30-day grace, privacy settings UI, three
tables, `legal.ts` + tests.

### Phase 1 — Execute the promised rights (launch-blocking, ~half a day)

1. Deletion purge worker: `POST /api/admin/legal/run-worker` (admin/cron-token auth, same
   pattern as `api/admin/alerts/run-worker.ts`) — finds `deletion_requests` past grace with
   `status='pending'`, calls `performHardDelete`, marks completed. VPS cron hits it daily.
2. Complete `buildExportPayload`: add tracked `builders`, `plans`, `plan_changes`,
   `plan_requests`; add a test asserting the payload covers every user-keyed table.

### Phase 2 — Lifecycle emails (small, needs `RESEND_API_KEY` in prod)

Deletion-scheduled (with cancel link/date), deletion-completed, export-ready. All no-op
gracefully when Resend is unconfigured (existing `email.ts` behavior).

### Phase 3 — Ops checklist (non-code, before launch)

Real imprint details, DMCA agent registration, document read-through against the current
product (e.g., privacy policy must not claim processors we don't use — no Stripe, no
PostHog; today the only processors are the hosting VPS and Resend).

## Risks

| Risk                                                      | Likelihood | Mitigation                                                                                                                                             |
| --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hard delete removes rows another feature still references | Medium     | `performHardDelete` already encodes the cascade order and is tested; new task adds tracked-builders/plans coverage with FK-order test on a seeded user |
| Worker endpoint abused                                    | Low        | Admin session or `CRON_SECRET` header, idempotent, rate-limited like the alerts worker                                                                 |
| Privacy policy drifts from actual processors              | Medium     | Phase 3 read-through; keep the subprocessor list short and factual                                                                                     |

## Rollback

Worker endpoint is additive; disable the cron to stop purges. Export additions are additive
fields. Emails are optional-config. Hard deletes themselves are irreversible by design — the
30-day grace is the rollback window, which is why the worker only processes rows past
`grace_period_ends_at`.
