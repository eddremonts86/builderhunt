# Stripe Tax, KYC, and Country Expansion Runbook

## Denmark individual KYC/CVR/VAT gate (launch)

Every field below is tracked in `stripe-launch-register.md`'s "Seller and country" table — this doc
is the PROCEDURE; that register is the single source of truth for whether each step has actually
happened. As of this doc's writing, every one of these is still `_pending_`/`_not started_` there —
**do not treat this runbook as evidence any of them are done.**

1. **Stripe KYC** — completed entirely inside the Stripe Dashboard (Account → Business details).
   This app never collects, stores, or displays a CPR number, passport, or other personal ID —
   `stripe-launch-register.md`'s own header warns against ever pasting one into this repository.
   `stripe-live-readiness.md`'s `chargesEnabled` gate checks the RESULT (`charges_enabled` via the
   Stripe Accounts API, `--live` only) — never the underlying personal data.
2. **CVR registration** (Danish business registry number) — confirm this exists for the seller
   entity; record only a yes/no + confirmation date in the launch register, never the CVR number
   itself in this repo (it's not secret, but there's no reason to duplicate it here either — the
   Stripe Dashboard and the CVR registry are both already authoritative).
3. **VAT/OSS registration** — required before Denmark can charge tax correctly, and a hard
   prerequisite before ANY non-Denmark country is added to `getCurrentSellerProfile()`'s production
   customer-country allowlist (`stripe-live-readiness.md`'s `denmarkAllowlisted` gate only checks
   Denmark is present — it does not check that OTHER countries aren't also present without their own
   VAT/OSS coverage; that's an operator judgment call, not something this gate can verify).
4. **Product tax code** — a Stripe Tax classification (e.g. "SaaS subscription") set once at
   `provision-stripe-catalog.ts` time; confirm it in the Stripe Dashboard's Tax settings, not just in
   this codebase (`stripe-live-readiness.md`'s own "Known gaps" section already flags
   `taxConfigurationRecorded` as a proxy check — "at least one tax registration is on file" — not a
   real verification that the product tax code matches production configuration).
5. **Tax registrations recorded** — at least one `BillingSellerProfile.taxRegistrations` entry
   (country + registration id + effective date) via `/admin/billing`'s Seller Configuration panel,
   for every country actually charged tax in.

## EU/OSS expansion (adding a country beyond Denmark)

1. Confirm VAT/OSS registration covers the new country BEFORE adding it — Stripe Tax will happily
   compute a tax rate for a country you have no registration for; that's a compliance problem this
   app cannot detect for you.
2. Add a new tax registration to the current seller profile version (creates a NEW version — prior
   versions stay readable for historical invoices, per `seller-profile.ts`'s versioning contract).
3. Add the country to the production customer-country allowlist (same seller-profile update).
4. Re-run `pnpm billing:check-readiness --live` — confirm `taxConfigurationRecorded` and
   `denmarkAllowlisted`-equivalent checks still pass (the gate name is Denmark-specific; a broader
   multi-country gate does not exist yet — track this as a known gap if expansion actually happens).
5. Sandbox-test the new country's checkout flow (a real Test Clock subscription, `stripe-billing-legacy`
   migration path unaffected) before flipping the production allowlist for real customers.

## Remediation: a customer was charged with the wrong tax

This app has NO local tax-adjustment mechanism — Stripe Tax computes tax at charge time from the
customer's billing address and the seller's registered jurisdictions; there is nothing in this
codebase's schema to "correct" a tax line after the fact.

1. Confirm the actual mistake: wrong seller-side tax registration (misconfigured in Stripe Tax
   settings) vs. wrong customer-address country (customer error, or a country-allowlist gap).
2. The only remediation is a real Stripe refund (see `stripe-refunds.md`) for the over/under-charged
   amount, followed by a corrected re-charge if the subscription should continue — there is no
   partial "just the tax part" refund primitive; `decideRefund`'s policy decisions operate on the
   full or partial GRANT amount, not a tax line item specifically.
3. If the root cause was a seller-side misconfiguration, fix the Stripe Tax settings/registration
   before any further charges in that country, and note the incident in
   `stripe-incident-response.md`'s change log.

## Owner

Tax configuration correctness is ultimately a business/legal decision, not an engineering one — the
launch register's owner columns for CVR/VAT/tax rows are `_pending_`; do not treat any of the above
as "already handled" until a real named owner has confirmed each row there.
