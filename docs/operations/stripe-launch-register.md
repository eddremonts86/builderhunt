# Stripe Billing Launch Decision Register

> Plan: `stripe-billing-platform`. This register is the single source of truth for every
> commercial/legal/release decision the plan depends on. Update it in the same commit as any
> decision it records changes. **Never add a CPR/personal ID number, home address, live secret,
> card number, or bank account/routing number here or anywhere in this repository** — those live
> only inside Stripe's own KYC flow.

## Catalog and currency

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Currency | USD only, no BuilderHunt-side conversion | confirmed | `src/shared/lib/billing/catalog.ts` — every entry is `currency: 'usd'` |
| Catalog | Free/Pro/Pro Max/Team + 3 credit packs, amounts per `spec.md`; all 9 live Stripe Price IDs provisioned | confirmed 2026-07-23 | `catalog.ts`; `pnpm billing:check-readiness --live` → `catalogLivePriceIdsComplete: true` |
| Client price selection | Catalog keys only — server resolves the Stripe Price ID, never a client-submitted amount/Price ID | confirmed | enforced in `src/shared/lib/billing/catalog.ts`'s `resolveSubscriptionCatalogKey`/`resolvePackCatalogKey` |

## Seller and country

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Seller classification | Individual, established in Denmark | confirmed | `billing_seller_profiles` v2: `establishment_country=DK` |
| Production customer allowlist | Denmark only at launch | confirmed | `billing_seller_profiles` v2: `country_allowlist=["DK"]` |
| CVR registration | Not registered as a company — operating as a private individual, per Stripe's individual-seller KYC path | confirmed 2026-07-24 | Stripe Dashboard KYC (`charges_enabled=true`); no CVR applies to an individual seller |
| VAT/OSS registration | Not VAT-registered | confirmed 2026-07-24 | `billing_seller_profiles` v2 tax registration: `{country: DK, registrationId: INDIVIDUAL_NOT_VAT_REGISTERED, effectiveAt: 2026-07-24}` |
| Stripe KYC (`charges_enabled`) | Complete | confirmed 2026-07-24 | `pnpm billing:check-readiness --live` → `chargesEnabled: true` |
| Stripe Tax registrations | On file for Denmark | confirmed 2026-07-24 | same seller profile row above |
| Product tax code | `txcd_10103000` (SaaS/software) | confirmed | `scripts/billing/provision-stripe-catalog.ts`'s `TAX_CODE` constant, applied to every live Product |

## Payment methods and consent

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Approved methods at launch | Card + Apple Pay/Google Pay wallets (immediate settlement only) | _pending confirmation_ | `spec.md` non-goals: no bank debit/transfer/BNPL/delayed methods at launch |
| Promotion codes | Subscriptions only, not packs | _pending confirmation_ | `spec.md` §Commercial contract |
| Public automatic trial | None — operator-only manual trials/promo grants | _pending confirmation_ | `spec.md` §Commercial contract |

## Legal documents

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Terms of Service version in force | `v1.0`, dated 2026-07-16, matches `CURRENT_CONSENT_VERSIONS.tos` | confirmed | `src/routes/_landing/legal/terms.tsx`, `src/shared/lib/legal.ts` |
| Privacy Policy version in force | `v1.0`, dated 2026-07-24 (updated this launch to disclose Stripe as a subprocessor), matches `CURRENT_CONSENT_VERSIONS.privacy` | confirmed | `src/routes/_landing/legal/privacy.tsx` §3 |
| Refund policy text | Written in the pricing page FAQ: unused credit packs refundable on request; subscription refunds reviewed case by case via `hello@builderhunt.dev` | confirmed | `src/routes/_landing/pricing.tsx` FAQ + the Checkout consent checkbox that references it |

## Support and operations

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Support/refund contact | `hello@builderhunt.dev` — consolidated from two different addresses in use | confirmed 2026-07-24 | `billing_seller_profiles` v3 (`supportEmail`) now matches `pricing.tsx`, `roadmap.tsx`, and `legal/imprint.tsx`, which already used this address site-wide |
| Statement descriptor | `BUILDERHUNT` | confirmed | `billing_seller_profiles` v2 |
| Financial record retention | _not decided_ | _pending_ | Danish bookkeeping law requires invoice/accounting records for 5 years; confirm exact schedule before relying on any backup-rotation policy that could delete within that window |
| Incident/kill-switch owner | Edd Remonts | confirmed 2026-07-24 | has Stripe Dashboard + deploy access |
| Secret rotation owner | Edd Remonts | confirmed 2026-07-24 | same |
| Stripe Billing Portal configuration | Restricted (`bpc_1Twg3NFbQx9fJlcGpkbiTqgy`, live mode): payment methods + tax ID + invoice history enabled; plan switching and cancellation disabled | confirmed 2026-07-24 | verified directly against the Stripe live API; matches `real-provider.ts`'s `ensureRestrictedPortalConfiguration()` |
| Production webhook endpoint | Two destinations exist, same URL/18 events: `builderhunt-production` (live mode, currently receiving nothing — production runs the test key) and `builderhunt-production-testmode` (test mode, currently active — verified with a real 200 response after a manual resend) | confirmed 2026-07-24 | Stripe Dashboard → Workbench → Webhooks |
| `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` | Set locally; **not yet present in the production Coolify environment** | _pending_ | see "Production environment gap" below — must be pushed before `STRIPE_BILLING_ENABLED=true` |

### Production environment gap (found 2026-07-24) — resolved, then deliberately reversed to test mode

The production Coolify app initially had **none** of the Stripe-related env vars configured, then
was briefly configured with LIVE credentials (`STRIPE_BILLING_ENABLED=false`, so harmless). Per an
explicit product decision the same day: **production now intentionally runs on Stripe TEST-mode
credentials with `STRIPE_BILLING_ENABLED=true`**, so trusted friends/testers can use the real
deployed app and exercise the entire real Checkout/webhook/entitlement pipeline with Stripe's test
cards — zero real money at risk — before the actual public/live launch. Concretely:

- Local dev now has `.env.local` (gitignored, Vite/vitest-prioritized over `.env`) holding the same
  test-mode `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`VITE_STRIPE_PUBLISHABLE_KEY` as production,
  plus `STRIPE_BILLING_ENABLED=true` — `RealBillingProvider` runs everywhere in dev/CI now, never the
  fake provider, without any live-money risk. `vitest.config.ts` layers `.env.local` over `.env` with
  `override: true` so the test suite picks the same safe defaults as `pnpm dev`.
- `.env` still holds the real `sk_live_...`/live webhook secret, `STRIPE_BILLING_ENABLED=false` — this
  is the "break glass for the actual launch" file, untouched by day-to-day dev work.
- A SECOND webhook destination (`builderhunt-production-testmode`, test mode, same 18 events) was
  created in Stripe pointing at the same production URL — the earlier LIVE-mode destination
  (`builderhunt-production`) stays configured but currently receives nothing, since production is on
  the test key.
- Verified end to end for real: after the redeploy, a genuinely failed test-mode webhook delivery
  (`invalid_signature`, from events fired before the redeploy picked up the new secret) was manually
  resent from the Stripe Dashboard and returned a real `200 {"received":true,...}` from production.
- The Coolify `envs` API requires `POST` to create a key and `PATCH` to update an existing one
  (`POST` on an existing key 409s) — worth remembering for future env pushes.
- The preview-scope duplication behavior from the earlier live-key push (see below) was NOT repeated
  here deliberately — test-mode secrets carry no real-money risk, so they were left in both scopes.

**Still true and unchanged**: flipping to the REAL live launch requires swapping these four vars back
to the values already sitting in `.env` (`sk_live_...`, the live webhook secret, the live publishable
key) plus everything else the `billingFlagEnabledInLiveMode` gate and the Denmark canary require —
this test-mode soft-launch state is not itself the live launch, just a safe rehearsal of the full
pipeline.

## Technical pins

| Decision | Value | Owner | Evidence |
| --- | --- | --- | --- |
| Stripe SDK version | `stripe@22.3.2` | confirmed | `package.json` |
| Stripe API version | `2026-06-24.dahlia` | confirmed | `STRIPE_API_VERSION` in `.env`; matches the SDK, the webhook endpoint (Stripe Dashboard confirms `2026-06-24.dahlia`), and every test fixture |
| `STRIPE_BILLING_ENABLED` default | `false` everywhere until Phase 15 | confirmed | `.env.example` |

## Release gates (must all have evidence before `STRIPE_BILLING_ENABLED=true` in production)

- [x] Sandbox catalog manifest validated against live Stripe Products/Prices. 2026-07-23: all 9
      catalog Prices created and validated in test sandbox; 2026-07-23 (later): all 9 live Price IDs
      provisioned too via `pnpm stripe:provision --write --allow-live` — `catalogLivePriceIdsComplete`
      gate passes.
- [x] Signed webhook fixture + duplicate/invalid-signature test matrix passes —
      `webhook-inbox.test.ts` covers duplicate delivery (no double-insert), tampered payload, tampered
      signature, and rotation-window (previous secret) cases.
- [x] Credit ledger property/concurrency tests pass (non-negative balance, no double-spend) —
      `fast-check`-based property tests in `credits.test.ts`/`reservations.test.ts`.
- [x] Tenant A/B isolation and platform/organization role matrix pass under real RLS roles —
      `billing-tenant-isolation.test.ts`, verified against a real disposable Postgres.
- [x] Test Clock lifecycle certified 2026-07-24 — `test-clock-lifecycle.test.ts`, run for real against
      Stripe's `test_helpers.test_clocks` API (never mocked): creation → real renewal (2nd paid
      invoice) → upgrade (real proration on the upcoming invoice) → downgrade → cancellation, plus a
      dedicated Jan-31-start subscription proving Stripe's real month-end anniversary rule (renews
      Feb 28 in a non-leap year, not Mar 3 or any drifted date), plus a dedicated case proving a real
      declined renewal (via `pm_card_authenticationRequired`, since this account disables raw-card
      Tokens API access) puts the subscription into `past_due` — the actual assumption the seven-day
      dunning code relies on. Discovered along the way that this project's original catalog-provision
      test sandbox no longer exists / was reset (its Price IDs 404'd against every currently-known
      test key) — re-provisioned via `pnpm stripe:provision --write` against the current sandbox,
      `catalog.ts`'s `test` column now points at real, live Price IDs again.
- [x] Refund, dispute, and auto-recharge cap scenarios pass — `refunds.test.ts`, `disputes.test.ts`,
      auto-recharge tests from §8 tasks 2 and 4.
- [x] Daily reconciliation detects and repairs an injected mismatch — `reconciliation.test.ts` injects
      `missing_internal`/`extra_internal`/`stale_internal` cases across customers/subscriptions/refunds
      and asserts detection; also verified against a real cron-triggered run this session (commit
      `299c9f1`).
- [x] KYC, tax registration, Terms/Privacy versions, and support contact all confirmed above
      (2026-07-24).
- [~] Incident, secret-rotation, refund, and backup/restore runbooks exist and have a tabletop
      exercise on record. 2026-07-24: exercised for real — see `stripe-incident-response.md`'s change
      log. 3 of 4 scenarios have genuine evidence (real secret-leak rotation, real reconciliation bug
      found via the webhook-recovery backstop, real restore rehearsal with a bug found and fixed);
      outage and wrong-tax-country scenarios were walked on paper only. Incident/kill-switch and
      secret-rotation owners are still unnamed — see "Support and operations" above.
- [~] Denmark canary: one real voluntary customer, one successful charge + refund + reconciliation
      cycle observed before any percentage rollout. 2026-08-04: **split** — see
      `stripe-live-rollout.md`. Seven of the canary's nine observations are now certified against real
      test-mode Stripe (`canary-certification.test.ts`, 7/7: charge, invoice, tax calculation, refund,
      reconciliation, account identity, plus the grant and rollback owned by `webhook-handlers.test.ts`
      and `stripe-provider.test.ts`). What remains is genuinely live-only: one real customer, one real
      charge, and one payout observed with its FX line — test mode produces no payout objects at all,
      and the catalog's USD pricing against this DKK-settling account means every payout involves a
      conversion no test object carries.

## Change log

- 2026-07-23 — register created (task 0.2). All gates start `_pending_`; no Stripe account, catalog,
  or legal-document work has happened yet.
- 2026-07-23 — Stripe test account created (Denmark, individual). Test API keys in `.env`
  (`STRIPE_BILLING_ENABLED=false`). SDK pinned `stripe@22.3.2`; API version pinned
  `2026-06-24.dahlia`. Catalog provisioned and validated in the test sandbox via
  `scripts/billing/provision-stripe-catalog.ts` — "Validate Stripe Products and Prices" gate met
  for test. Still pending: Stripe Tax registration, webhook endpoint/secret, KYC/live activation.
- 2026-07-24 — This register audited end-to-end against real, current state (most of the tables
  above had gone stale as decisions got made in code/Stripe without this doc being updated). Real
  work done this pass: live catalog Price IDs provisioned; Stripe KYC completed
  (`charges_enabled=true`); seller profile v2 recorded with real statement descriptor, support email,
  DK tax registration, and DK-only country allowlist; production webhook endpoint created in Stripe
  live mode; the restricted Customer Portal configuration created and verified in live mode; a
  previously-missing `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` gap found and fixed locally (added as a new
  `webhookPayloadEncryptionKeyConfigured` readiness gate — it wasn't checked at all before); a stale
  hardcoded migration count in the restore-rehearsal script found and fixed via a real rehearsal run;
  `stripe-incident-response.md`'s kill-switch section found describing an architecture that no longer
  exists (no real adapter) and corrected. Found and NOT yet fixed: **production has zero Stripe env
  vars configured in Coolify** — must be pushed before the live flag can ever be flipped. Remaining
  open items, all requiring a human decision rather than code: incident/secret-rotation owner names,
  financial retention schedule confirmation, Test Clock lifecycle certification, and the Denmark
  canary itself.
