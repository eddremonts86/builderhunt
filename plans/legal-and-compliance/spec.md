# Feature: Legal & Compliance (TOS, Privacy, GDPR)

## Problem

BuilderHunt no tiene:
- Terms of Service
- Privacy Policy
- Cookie Policy
- GDPR / CCPA compliance (data export, deletion)
- DMCA agent (US copyright law)
- Imprint (required in Germany/EU)

Si lanzamos a prod sin esto:
1. **Stripe no procesará pagos** sin TOS + Privacy URLs
2. **Apple App Store / Google Play** requieren Privacy Policy (si vamos mobile)
3. **EU users** pueden reclamar bajo GDPR
4. **US investors / customers** esperan disclosures legales
5. **Worst case**: lawsuit, fines (GDPR hasta 4% revenue)

## Goal

Cumplimiento legal mínimo viable:
- Terms of Service (TOS)
- Privacy Policy
- Cookie Policy
- GDPR-compliant data export + deletion
- DMCA registered agent (US)
- Imprint (EU)

## Non-goals (v1)

- **No es SOC2 / ISO27001.** v1: trust signals via transparency, not certification
- **No es HIPAA / PCI-DSS.** No manejamos health data o payment data directly (Stripe does)
- **No es un DPO (Data Protection Officer) hires.** Self-managed for v1
- **No es un Cookie consent banner detallado.** v1: simple banner with "Accept all" / "Reject non-essential"
- **No es multi-jurisdictional legal review.** v1: templates from Termly / Iubenda

## User stories

1. **Como visitor**, quiero ver qué data recolectáis y por qué antes de registrarme
2. **Como user de la EU**, quiero poder exportar toda mi data (GDPR Art. 20)
3. **Como user de la EU**, quiero poder eliminar mi cuenta y todos mis datos (GDPR Art. 17)
4. **Como user de California (CCPA)**, quiero un "Do Not Sell My Info" link
5. **Como visitor**, quiero poder rechazar cookies no-esenciales
6. **Como copyright holder**, quiero reportar DMCA violations

## Legal documents

### 1. Terms of Service (`/legal/terms`)

Sections:
- Acceptance
- Service description
- User accounts
- Acceptable use (no spam, no scraping, no illegal)
- Content ownership (user owns their data; we own platform code)
- Termination (we can ban you for TOS violations; you can delete anytime)
- Disclaimers (no warranty, "use at your own risk")
- Limitation of liability
- Governing law (Delaware for US, default)
- Dispute resolution (arbitration)
- Contact

**Source**: Termly template + customization, or attorney review ($$)

**Versioned**: each update has a version number + date; user must re-accept on next login

### 2. Privacy Policy (`/legal/privacy`)

Sections:
- Data we collect (account, saved searches, saved builders, notes, claims)
- How we use it (provide service, recommendations, alerts)
- Who we share with (Stripe for payments, Sentry for errors, PostHog for analytics — all DPA-signed)
- Cookies (essential, analytics, marketing)
- Data retention (we keep your data until you delete your account)
- Your rights (GDPR: access, export, delete, restrict; CCPA: opt-out)
- Children's privacy (we don't target <16)
- International transfers (EU data may be processed in US)
- Contact: privacy@builderhunt.dev

### 3. Cookie Policy (`/legal/cookies`)

- List of cookies used
- Purpose of each
- How to opt out
- Browser-specific instructions

### 4. Imprint (`/legal/imprint`)

- Company name
- Address (Delaware LLC, US; Berlin GmbH if EU later)
- Contact email
- Tax ID / VAT (when applicable)
- Responsible for content

## Data model

**New table: `user_consents`**

```sql
CREATE TABLE user_consents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  document text NOT NULL,  -- 'tos' | 'privacy' | 'cookies'
  version text NOT NULL,    -- e.g., 'v1.0'
  accepted_at timestamp with time zone DEFAULT now() NOT NULL
);
```

**New table: `data_export_requests`**

```sql
CREATE TABLE data_export_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'ready' | 'failed'
  download_url text,  -- signed URL to download
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
```

**New table: `deletion_requests`**

```sql
CREATE TABLE deletion_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) UNIQUE,
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed'
  grace_period_ends_at timestamp with time zone NOT NULL,  -- 30 days from request
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
```

## API endpoints

- `GET /api/me/data-export` — POST creates export job
- `GET /api/me/data-export/:id` — check status, get download URL
- `POST /api/me/delete-account` — start deletion (30-day grace)
- `POST /api/me/cancel-deletion` — undo within grace period
- `POST /api/consent` — record consent acceptance

## UX flow

### Cookie banner (first visit)

```
┌─────────────────────────────────────────────────────┐
│  🍪 We use cookies                                   │
│  Essential + analytics cookies. You can accept all  │
│  or only essential.                                   │
│  [Accept all]  [Essential only]  [Customize]         │
└─────────────────────────────────────────────────────┘
```

Stored in localStorage: `builderhunt.cookieConsent = { essential: true, analytics: bool, ... }`

### Account deletion

```
Settings → Danger Zone → Delete Account
↓
Confirmation modal:
"This will delete your account, saved searches, saved builders,
notes, and all data in 30 days. You can cancel anytime within the
30-day grace period by signing in."
[ Cancel ]  [ Confirm deletion ]
↓
Email: "Account scheduled for deletion on YYYY-MM-DD. Cancel: link"
↓
30 days later: hard delete (run script)
```

### Data export

```
Settings → Privacy → Export my data
↓
"This is a JSON file with all your data: profile, saved searches,
saved builders, notes, claims. We'll email you a download link when
it's ready (within 24h)."
[ Request export ]
↓
Email: "Your data export is ready. Download: link (expires in 7 days)"
```

## Implementation

### Cookie banner

File: `src/shared/components/CookieBanner.tsx`

- Render on first visit (check localStorage)
- 3 buttons: Accept all, Essential, Customize
- On accept: write to localStorage + call `posthog.opt_in()` or `posthog.opt_out()`
- Sentry: always on (essential for service)

### Data export

File: `src/routes/api/me/data-export.ts` (new, POST)

- Create row in `data_export_requests`
- Background job (cron): find pending requests, query all user data, write JSON to S3, update status='ready', send email
- Download URL is signed, expires in 7 days

Background job: `scripts/jobs/process-data-exports.ts`, run every hour

### Account deletion

File: `src/routes/api/me/delete-account.ts` (new, POST)

- Create row in `deletion_requests` with grace_period_ends_at = now + 30 days
- Send confirmation email
- Daily cron: process expired deletions (hard delete user + all data)

**Hard delete cascade**:
- authUsers (cascade deletes authSessions, authAccounts)
- savedQueries (cascade)
- builders (cascade deletes builderNotes)
- builderNotes
- builderProfileViews
- builderClaimRequests
- onboarding_progress
- subscriptions
- public_radars
- deletion_requests (the row itself)

File: `scripts/jobs/process-deletions.ts`, run daily

### TOS re-acceptance

On sign-in, check if `user_consents` exists for current `tos` version. If not, show modal:
```
"We updated our Terms of Service. Please review and accept to continue."
[ Read terms ]  [ Accept and continue ]
```

On accept, insert row in `user_consents`.

## GDPR specifics

- **Right to access**: `/settings/privacy` shows all data we have
- **Right to export**: see above
- **Right to delete**: see above
- **Right to restrict processing**: contact form
- **Right to data portability**: JSON export is portable
- **Right to object**: opt-out of analytics, marketing emails

## CCPA specifics

- "Do Not Sell My Info" link in footer
- Honors opt-out signals (Global Privacy Control)

## Cookie usage

| Cookie | Purpose | Type | Lifespan |
|--------|---------|------|----------|
| `bh_session` | Auth session | Essential | 30 days |
| `bh_cookie_consent` | Remember consent | Essential | 1 year |
| `bh_onboarding_state` | Onboarding state | Functional | 30 days |
| PostHog cookie | Analytics | Optional | 1 year |

## Imprint (Germany)

If incorporating in Germany (vs US Delaware LLC), need Impressum per TMG §5:
- Full company name
- Address
- Contact (email, phone)
- VAT ID
- Responsible for content (per §18 MStV)
- Chamber of commerce (if applicable)

## Disclaimers

- BuilderHunt indexes PUBLIC data from public APIs. We are not responsible for accuracy.
- Verified badge = "claimed by email", not "endorsed by us"
- We do not guarantee uptime, accuracy, or non-termination
- Users responsible for what they do with data (don't spam builders, comply with GDPR/CCPA themselves)

## Out of scope (v1)

- Cookie consent granular (per-category)
- Internationalization of legal docs (English only v1)
- A/B testing of consent flows
- Subprocessor list page
- DPIA (Data Protection Impact Assessment)
- EU representative
- DPO contact (only when required)

## Open questions

- **US (Delaware LLC) or EU (Germany GmbH)?** US v1 (simpler, faster, no VAT initially), EU v2 if traction
- **Stripe Tax enabled?** v1: no (Stripe handles for US), v2: enable when adding EU
- **Use Termly / Iubenda templates or attorney?** Templates v1 (~$200/yr), attorney v2 if B2B sales
- **Cookie consent granularity?** Simple (essential + analytics) v1, granular v2

## Dependencies

- New tables: `user_consents`, `data_export_requests`, `deletion_requests`
- New package: none (built-in)
- Schema migrations: 3 new tables
- New env vars: `LEGAL_COMPANY_NAME`, `LEGAL_ADDRESS`, `LEGAL_TAX_ID`
- New background jobs: `process-data-exports`, `process-deletions`
- New email templates: data-export-ready, deletion-scheduled, deletion-completed

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Legal docs (TOS, Privacy, Cookies, Imprint) | S (3-4h) — mostly writing |
| 2 — Cookie banner | S (2-3h) |
| 3 — TOS re-acceptance | S (2-3h) |
| 4 — Data export | M (4-6h) |
| 5 — Account deletion (with grace) | M (4-6h) |
| 6 — GDPR rights UI | S (3-4h) |
| 7 — CCPA "Do Not Sell" | XS (1h) |
| 8 — DMCA agent registration | XS (1h) |
| **Total** | **~3 days** |
