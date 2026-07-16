# Tasks: Pricing & Billing

## Phase 0 — Research

- [ ] Sign up for Stripe account
- [ ] Create products in Stripe dashboard: Pro ($19/mo, $182/yr), Team ($99/mo, $950/yr)
- [ ] Get API keys (test mode for dev)
- [ ] Read `src/shared/lib/auth/better-auth.ts` to understand session structure

## Phase 1 — Data model

- [ ] Add `subscriptions` table to schema
- [ ] Add `team_memberships` table to schema
- [ ] Generate + apply migration
- [ ] Add `STRIPE_*` env vars to `src/shared/lib/env.ts` (optional, validate as z.string().optional())

## Phase 2 — Stripe SDK

- [ ] `pnpm add stripe`
- [ ] Create `src/shared/lib/stripe.ts` with configured client
- [ ] Helper: `getOrCreateCustomer(userId, email)`
- [ ] Helper: `getSubscription(userId)` (cache 5min)

## Phase 3 — Pricing page

File: `src/routes/pricing.tsx` (new, public)

- [ ] 3 tier cards: Free, Pro ($19/mo or $182/yr), Team ($99/mo or $950/yr)
- [ ] Monthly/Annual toggle (20% off shown)
- [ ] Feature comparison table
- [ ] FAQ section
- [ ] "Current plan" badge for logged-in users
- [ ] CTA: "Start free trial" or "Get Pro" → /api/stripe/checkout

## Phase 4 — Checkout + webhooks

- [ ] `src/routes/api/stripe/checkout.ts`: POST creates Stripe Checkout Session
- [ ] `src/routes/api/stripe/webhook.ts`: handles events
  - subscription.created/updated → upsert
  - subscription.deleted → mark canceled
  - invoice.paid → extend period
  - invoice.payment_failed → mark past_due
- [ ] Verify webhook signature with `STRIPE_WEBHOOK_SECRET`
- [ ] On `customer.subscription.created`, start 14-day trial

## Phase 5 — Settings page

File: `src/routes/_dashboard/settings/billing.tsx`

- [ ] Current plan card
- [ ] "Manage subscription" button → opens Stripe Customer Portal
- [ ] Payment method (last 4 digits)
- [ ] Next billing date
- [ ] Cancel at period end indicator
- [ ] Invoice history (links to Stripe PDF)

## Phase 6 — Limit enforcement

File: `src/shared/lib/limits.ts` (new)

- [ ] Constants: `FREE_LIMITS = { savedSearches: 3, savedBuilders: 50, ... }`
- [ ] `checkLimit(userId, resource)` returns `{ allowed, current, limit, plan }`
- [ ] Update POST `/api/queries` to return 402 with paywall data when over limit
- [ ] Update POST `/api/builders/:id/save` (when it exists) to return 402
- [ ] Hide Pro features in UI for free users (greyed out, "Upgrade" tooltip)
- [ ] Show usage meter in `/settings/billing` ("3/3 saved searches")

## Phase 7 — Team plan

File: `src/routes/_dashboard/team.tsx` (new)

- [ ] Team owner can invite members (email-based)
- [ ] Member roles: owner (billing), admin (manage members), member (read access)
- [ ] Shared saved searches / lists
- [ ] Activity feed: "Alice saved a new builder"

## Phase 8 — Verification

### Manual
- [ ] Click "Get Pro" → Stripe Checkout opens
- [ ] Use test card 4242 4242 4242 4242
- [ ] Webhook fires, subscription created in DB
- [ ] User redirected to dashboard with success state
- [ ] Try to create 4th saved search as free user → 402
- [ ] Cancel subscription via customer portal → status updated
- [ ] Annual plan toggle works, correct price shown

### Automated (Playwright)
- [ ] Pricing page renders 3 cards
- [ ] Click "Get Pro" redirects to Stripe (mocked or skip)
- [ ] Free user hits saved search limit, sees paywall modal

### Performance
- [ ] Webhook response < 500ms
- [ ] Pricing page TTFB < 200ms

## Phase 9 — Rollout

- [ ] Soft launch: 10% of users see pricing page
- [ ] Monitor conversion, churn, payment failures
- [ ] Email all users: "We added Pro. Here's what you get."
- [ ] If conversion < 1% after 2 weeks, reconsider limits

## Edge cases

- **Payment failure after trial**: downgrade to Free, email user, give 7-day grace
- **Webhook duplicate events**: idempotent handlers (use stripe_event_id)
- **User has multiple Stripe customers** (created in different sessions): always reuse latest
- **Annual plan cancel mid-year**: refund prorated by Stripe
- **Team plan downgrade**: keep members' saved data, just remove team features
- **Free → Pro → Free → Pro**: cumulative, no penalty

## Dependencies

- Existing: `authUsers`, `savedQueries`, `builders` tables
- New package: `stripe`
- New env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_*`
- Schema: 2 new tables

## Estimated effort: 3-4 days
