# Tasks: Legal & Compliance

## Phase 0 — Research

- [ ] Read `src/modules/auth/components/SignUpPage.tsx` to find where to inject consent checkbox
- [ ] Read `src/routes/api/auth/$.ts` to see signup handler (for email verification copy)
- [ ] Check existing footer (if any) for "Terms / Privacy" links
- [ ] Choose legal template: Termly ($200/yr) vs Iubenda vs DIY with templates

## Phase 1 — Legal documents

File: `src/routes/legal/terms.tsx` (new)

- [ ] Write Terms of Service (use Termly template as base, customize)
- [ ] Sections: acceptance, service, accounts, acceptable use, content ownership, termination, disclaimers, liability, governing law, dispute resolution, contact
- [ ] Versioned: `v1.0 - 2026-07-16`
- [ ] Add to footer

File: `src/routes/legal/privacy.tsx` (new)

- [ ] Write Privacy Policy
- [ ] Sections: data collected, how we use, who we share with (Stripe, Sentry, PostHog), cookies, retention, your rights, children, international, contact
- [ ] List subprocessors with links to their privacy policies

File: `src/routes/legal/cookies.tsx` (new)

- [ ] List each cookie, purpose, type, lifespan
- [ ] Browser-specific opt-out instructions

File: `src/routes/legal/imprint.tsx` (new)

- [ ] Company name, address, contact, tax ID

## Phase 2 — Cookie banner

File: `src/shared/components/CookieBanner.tsx` (new)

- [ ] 3 buttons: Accept all, Essential, Customize
- [ ] On mount, check `localStorage.getItem('bh_cookie_consent')`
- [ ] If unset, show banner
- [ ] On accept: save to localStorage + call `posthog.opt_in_capturing()` / `opt_out_capturing()`
- [ ] Sentry always on (essential)

File: `src/routes/-root-components.tsx`

- [ ] Render `<CookieBanner />` at root

## Phase 3 — Data model

- [ ] Add `user_consents`, `data_export_requests`, `deletion_requests` tables to schema
- [ ] Generate + apply migration

## Phase 4 — TOS re-acceptance

File: `src/routes/_dashboard/_layout.tsx` (or similar)

- [ ] On dashboard mount, fetch `/api/me/consent-status`
- [ ] If TOS not accepted for current version, show modal blocking the UI
- [ ] "Read terms" link + "Accept" button
- [ ] On accept: POST /api/consent

File: `src/routes/api/consent/index.ts` (new, POST)

- [ ] Body: `{ document: 'tos' | 'privacy' | 'cookies', version: string }`
- [ ] Auth required
- [ ] Insert row in `user_consents`

## Phase 5 — Data export

File: `src/routes/api/me/data-export.ts` (new, POST)

- [ ] Auth required
- [ ] Create row in `data_export_requests` with status='pending'
- [ ] Return request id

File: `src/routes/api/me/data-export/$id.ts` (new, GET)

- [ ] Returns status + download URL when ready
- [ ] Download URL is signed, expires 7 days

File: `scripts/jobs/process-data-exports.ts` (new)

- [ ] Find pending requests
- [ ] Query all user data: authUsers, savedQueries, builders, builderNotes, subscriptions, etc.
- [ ] Write to JSON
- [ ] Upload to S3 (signed URL)
- [ ] Update status='ready', set expires_at
- [ ] Send email with download link
- [ ] Schedule: cron every 1h

File: `src/routes/_dashboard/settings/privacy.tsx` (new)

- [ ] "Export my data" button
- [ ] "Delete my account" button (in danger zone)
- [ ] "Cookie preferences" link

## Phase 6 — Account deletion

File: `src/routes/api/me/delete-account.ts` (new, POST)

- [ ] Auth required
- [ ] Create row in `deletion_requests` with `grace_period_ends_at = now + 30 days`
- [ ] Send confirmation email
- [ ] Sign out user (invalidate session)

File: `src/routes/api/me/cancel-deletion.ts` (new, POST)

- [ ] Auth required
- [ ] Delete the pending `deletion_requests` row
- [ ] User can sign in normally

File: `scripts/jobs/process-deletions.ts` (new)

- [ ] Find `deletion_requests` where `grace_period_ends_at < now`
- [ ] Hard delete: `authUsers` (cascades to everything)
- [ ] Update status='completed', `completed_at=now`
- [ ] Send final email
- [ ] Schedule: cron daily

## Phase 7 — CCPA "Do Not Sell"

File: `src/shared/components/Footer.tsx` (new or extend existing)

- [ ] Add "Do Not Sell My Info" link (anchored in California)
- [ ] Honor Global Privacy Control (GPC) signal: if user has it set, opt out automatically

File: `src/routes/api/privacy/opt-out.ts` (new, POST)

- [ ] Set analytics opt-out for current user (or by IP if anonymous)

## Phase 8 — DMCA agent

- [ ] Register DMCA agent with US Copyright Office ($6 fee)
- [ ] Add to Imprint
- [ ] Email: dmca@builderhunt.dev
- [ ] Process: log complaint, review, act (remove or counter-notice)

## Phase 9 — Footer

File: `src/shared/components/Footer.tsx` (new)

- [ ] Links: Pricing, About, Blog, Status
- [ ] Legal: Terms, Privacy, Cookies, Imprint
- [ ] Social: Twitter, GitHub, LinkedIn
- [ ] © 2026 BuilderHunt. All rights reserved.

## Phase 10 — Verification

### Manual
- [ ] Visit /legal/terms → renders full text
- [ ] Cookie banner shows on first visit
- [ ] Sign up new user → TOS modal blocks dashboard
- [ ] Accept TOS → modal closes
- [ ] Request data export → email arrives within 1h with download link
- [ ] Request account deletion → confirmation email, 30-day grace
- [ ] Cancel deletion → user can sign in normally

### Automated
- [ ] Playwright: cookie banner appears, accept, refresh, banner gone
- [ ] Playwright: TOS modal blocks dashboard, accept, modal gone
- [ ] Playwright: data export request returns 200

### Compliance audit
- [ ] GDPR: all rights (access, export, delete, restrict, portability, object) are addressable
- [ ] CCPA: "Do Not Sell" link present
- [ ] Cookie consent: granular enough for EU
- [ ] Subprocessor list: complete and accurate
- [ ] Legal docs: written in plain language, easy to understand
- [ ] All required sections present (per GDPR Art. 13)

## Phase 11 — Rollout

- [ ] All legal docs reviewed by an attorney (optional but recommended for v1)
- [ ] Publish to /legal/*
- [ ] Email existing users: "We updated our privacy policy"
- [ ] New signups see consent flow
- [ ] Existing signups see TOS re-accept modal on next login

## Edge cases

- **User requests deletion, then signs in within 30 days**: cancel deletion, restore session
- **User requests multiple data exports**: cap to 1 per 7 days
- **User has saved searches and tries to delete account**: warning modal lists what will be lost
- **Cookie consent expired (1 year)**: re-prompt
- **User is in EU but using VPN showing US**: trust their browser language + timezone
- **Stripe webhook for subscription cancel during deletion**: handle gracefully (refund if applicable)

## Dependencies

- New tables: 3 (`user_consents`, `data_export_requests`, `deletion_requests`)
- New package: none (built-in)
- New background jobs: 2 (`process-data-exports`, `process-deletions`)
- New env vars: `LEGAL_COMPANY_NAME`, `LEGAL_ADDRESS`, `LEGAL_TAX_ID`, `LEGAL_CONTACT_EMAIL`
- Optional: Termly / Iubenda subscription ($200/yr)
- One-time: DMCA agent registration ($6)
- Recommended: attorney review ($500-2000 one-time)

## Estimated effort: 3 days
