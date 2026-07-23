# Stripe Billing Launch Decision Register

> Plan: `stripe-billing-platform`. This register is the single source of truth for every
> commercial/legal/release decision the plan depends on. Update it in the same commit as any
> decision it records changes. **Never add a CPR/personal ID number, home address, live secret,
> card number, or bank account/routing number here or anywhere in this repository** — those live
> only inside Stripe's own KYC flow.

## Catalog and currency

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Currency | USD only, no BuilderHunt-side conversion | _pending_ | `spec.md` §Commercial contract |
| Catalog | Free/Pro/Pro Max/Team + 3 credit packs, amounts per `spec.md` | _pending_ | `spec.md` §Commercial contract table |
| Client price selection | Catalog keys only — server resolves the Stripe Price ID, never a client-submitted amount/Price ID | _pending_ | enforced in `src/shared/lib/billing/catalog.ts` (task 1.2) |

## Seller and country

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Seller classification | Individual, established in Denmark | _pending confirmation_ | `spec.md` §Seller, country, currency, and tax configuration |
| Production customer allowlist | Denmark only at launch; EU scenarios sandbox-only | _pending confirmation_ | same |
| CVR registration | _not yet confirmed_ | _pending_ | attach CVR number confirmation (not the number itself — a yes/no + date) here once available |
| VAT/OSS registration | _not yet confirmed_ | _pending_ | required before any non-Denmark country is added to the production allowlist |
| Stripe KYC (`charges_enabled`) | _not started_ | _pending_ | Stripe Dashboard → Account → Business details; do not paste personal ID data here |
| Stripe Tax registrations | _not started_ | _pending_ | must exist for every country in the production allowlist before launch |
| Product tax code | _not chosen_ | _pending_ | Stripe Tax product tax code for "software / SaaS subscription" |

## Payment methods and consent

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Approved methods at launch | Card + Apple Pay/Google Pay wallets (immediate settlement only) | _pending confirmation_ | `spec.md` non-goals: no bank debit/transfer/BNPL/delayed methods at launch |
| Promotion codes | Subscriptions only, not packs | _pending confirmation_ | `spec.md` §Commercial contract |
| Public automatic trial | None — operator-only manual trials/promo grants | _pending confirmation_ | `spec.md` §Commercial contract |

## Legal documents

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Terms of Service version in force | _not yet versioned for billing disclosures_ | _pending_ | `src/routes/_landing/legal/terms.tsx` — needs a dated version once Checkout consent (task in §5) lands |
| Privacy Policy version in force | _not yet versioned for billing disclosures_ | _pending_ | `src/routes/_landing/legal/privacy.tsx` — same |
| Refund policy text | _not written_ | _pending_ | must match `spec.md` §Refund contract before Checkout ships |

## Support and operations

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Support/refund contact | _not designated_ | _pending_ | shown on Checkout and in billing settings; a real, monitored inbox, not a placeholder |
| Statement descriptor | _not chosen_ | _pending_ | shown on customer card statements; must not be misleading |
| Financial record retention | _not decided_ | _pending_ | Danish bookkeeping law requires invoice/accounting records for 5 years; confirm exact schedule before task "Prove migration backup, restore, and rollback safety" |
| Incident/kill-switch owner | _not designated_ | _pending_ | who flips `STRIPE_BILLING_ENABLED=false` in an outage |
| Secret rotation owner | _not designated_ | _pending_ | who rotates `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` on schedule or compromise |

## Technical pins

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Stripe SDK version | _not yet pinned_ | _pending_ | task "Install and pin the Stripe server dependency" — exact version in `package.json` |
| Stripe API version | _not yet pinned_ | _pending_ | must match the SDK, the webhook endpoint configuration, and every test fixture |
| `STRIPE_BILLING_ENABLED` default | `false` everywhere until Phase 15 | confirmed | `.env.example` |

## Release gates (must all have evidence before `STRIPE_BILLING_ENABLED=true` in production)

- [ ] Sandbox catalog manifest validated against live Stripe Products/Prices (task "Validate Stripe
      Products and Prices before mutation").
- [ ] Signed webhook fixture + duplicate/reordered/delayed/invalid-signature test matrix passes.
- [ ] Credit ledger property/concurrency tests pass (non-negative balance, no double-spend).
- [ ] Tenant A/B isolation and platform/organization role matrix pass under real RLS roles.
- [ ] Monthly and annual Test Clock lifecycles pass (creation, renewal, upgrade, downgrade, grace,
      cancellation, leap/month-end anniversaries).
- [ ] Refund, dispute, and auto-recharge cap scenarios pass.
- [ ] Daily reconciliation detects and repairs an injected mismatch.
- [ ] KYC, tax registration, Terms/Privacy versions, and support contact all confirmed above.
- [ ] Incident, secret-rotation, refund, and backup/restore runbooks exist and have a tabletop
      exercise on record.
- [ ] Denmark canary: one real voluntary customer, one successful charge + refund + reconciliation
      cycle observed before any percentage rollout.

## Change log

- 2026-07-23 — register created (task 0.2). All gates start `_pending_`; no Stripe account, catalog,
  or legal-document work has happened yet.
