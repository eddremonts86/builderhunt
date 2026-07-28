# Legal & Compliance (TOS, Privacy, GDPR)

> **Status**: `complete`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../53-waitlist-launch/spec.md)
> **Reality check**: Legal surface is largely live: `/legal/{terms,privacy,cookies,imprint}`
> pages, `CookieBanner` + `TosModal` rendered at root (`src/routes/-root-components.tsx`),
> consent API (`src/routes/api/consent/index.ts`), GDPR export + deletion endpoints
> (`src/routes/api/me/data-export/`, `api/me/delete-account/`), `src/shared/lib/legal.ts`
> (+ tests), tables `user_consents`/`data_export_requests`/`deletion_requests`. **All three
> phases done as of 2026-07-21**: hard deletion actually executes
> (`processPendingDeletions()` + `POST /api/admin/legal/run-worker`), the export payload
> includes tracked builders/plan/plan changes/plan requests, the hard-delete cascade covers
> builder notes/alerts/saved queries/builders, lifecycle emails (deletion-scheduled/
> deletion-completed/export-ready) send through the already-integrated free-tier Resend
> setup, the privacy-policy processor list matches the real deployed stack, and the imprint
> carries the operator's real name/address plus an honest DMCA-non-registration disclosure.
> Still needs a daily VPS cron pointed at the worker endpoint (non-code, see tasks.md).

## Problem

Launching without enforceable legal docs and working GDPR rights risks fines and blocks
future payment/marketplace integrations. Docs and request flows exist; the remaining problem
is that some rights are promised but not fully executed (deletion purge, complete export) and
users get no lifecycle emails.

## Goal

Every promised right actually executes: expired deletion grace periods hard-delete on a
schedule, the data export contains all personal data we hold, and export/deletion events
notify the user by email when Resend is configured.

## Non-goals

- No SOC2/ISO/HIPAA; no DPO; no EU representative; no DPIA (pre-revenue, minimal data).
- No granular per-category cookie consent (current banner: accept all / essential only —
  sufficient for the cookies actually set).
- No DPA document until there is a B2B/team customer asking for one (revisit when
  [`team-accounts`](../26-team-accounts/spec.md) ships paying teams).
- No legal-entity/incorporation work in this plan.
- No consent-flow A/B testing, no translated legal docs.

## Delivered (audited 2026-07-19)

- **Legal documents**: `src/routes/_landing/legal/{terms,privacy,cookies,imprint}.tsx`,
  versioned via `CURRENT_CONSENT_VERSIONS` in `src/shared/lib/legal.ts`; linked from the
  footer (`src/shared/components/Footer.tsx:75-79`, including a "Do Not Sell My Info"
  mailto link).
- **Cookie banner**: `src/shared/components/CookieBanner.tsx`, rendered at root, localStorage
  consent state.
- **TOS re-acceptance**: `src/shared/components/TosModal.tsx` at root + consent status/record
  API (`src/routes/api/consent/index.ts` → `getConsentStatus`/`recordConsent` in `legal.ts`).
- **Data export (GDPR Art. 20)**: `POST /api/me/data-export` builds the payload synchronously
  (`buildExportPayload`), stores it on the request row, throttles to 1/24h; `GET
/api/me/data-export/$id` serves it; 7-day expiry (`EXPORT_TTL_MS`). No S3/queue — correct
  for this scale per the no-new-queues constraint.
- **Account deletion (GDPR Art. 17)**: `POST /api/me/delete-account` creates a
  `deletion_requests` row with 30-day grace (`GRACE_PERIOD_MS`); `DELETE` cancels;
  `getDeletionRequest/requestDeletion/cancelDeletion/performHardDelete` in `legal.ts`
  (tests in `legal.test.ts`).
- **Privacy settings UI**: `src/routes/_dashboard/settings/privacy.tsx` (export, delete,
  cancel deletion).
- **Schema**: `user_consents`, `data_export_requests` (with jsonb payload), `deletion_requests`
  in `src/shared/lib/db/schema.ts`.

## Remaining work (each gap cited)

1. **Deletion purge never runs**: `performHardDelete` is exported from
   `src/shared/lib/legal.ts:176` but has **zero callers** in `src/` (grep confirms). Expired
   grace periods are never executed — the promised deletion silently doesn't happen. Fix with
   the standard HTTP-cron worker pattern (`/api/admin/legal/run-worker`, like
   `api/admin/alerts/run-worker.ts`).
2. **Export payload is incomplete**: `buildExportPayload` (`legal.ts:70-125`) exports user,
   auth meta, saved queries, alerts, notes, consents, claims, onboarding, deletion request,
   profile views — but **omits tracked `builders` rows, `plans`, `plan_changes`, and
   `plan_requests`**, all keyed by userId and clearly personal data.
3. **No lifecycle emails**: deletion scheduling only `console.log`s a message
   (`src/routes/api/me/delete-account/index.ts:26-31`); export-ready sends nothing. Resend
   infra exists (`src/shared/lib/email.ts`, optional `RESEND_API_KEY`).
4. **Ops checklist (non-code)**: DMCA agent registration, one-time review of the four
   documents (attorney or at minimum a template diff), and real company details in
   `/legal/imprint` before launch.

## Data lifecycle (authoritative once Phase 1 lands)

- Consent: recorded per document+version; new version ⇒ TosModal blocks until re-accept.
- Export: on-demand, complete snapshot, downloadable 7 days, throttled 1/24h.
- Deletion: request → 30-day grace (cancelable, sign-in warns) → worker hard-deletes all
  user-keyed rows + auth cascade → final email (if configured) → request row retained with
  `status='completed'` as the compliance record.

## Success metrics

- 100% of expired deletion requests purged within 24h of grace end (worker cron daily).
- Export payload includes every table with a userId column (checked by test).
- Zero consent-version drift: bumping a version in `legal.ts` forces re-acceptance.

## Resolved questions

- Worker vs queue: HTTP-triggered idempotent worker hit by VPS cron (per
  `_meta/app-reality.md` constraint 3). No new queue.
- Export delivery: inline JSON from the DB row (no S3) — fine at this scale.
- GPC auto-honor: out of scope; the mailto "Do Not Sell" link plus no ad-tech cookies keeps
  CCPA exposure minimal (we set no analytics/marketing cookies today).
