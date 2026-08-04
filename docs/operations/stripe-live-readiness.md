# Stripe Live Billing Readiness Gate

## What this gate is for

`STRIPE_BILLING_ENABLED=true` against a live (`sk_live_...`) key must never be set in production
until every gate below has real evidence — matching
`docs/operations/stripe-launch-register.md`'s "Release gates" checklist. The decision itself is a
pure function, `assessLiveBillingReadiness` (`src/shared/lib/billing/readiness.ts`): give it an
evidence struct, it returns `{ ready, missing }`. `pnpm billing:check-readiness` gathers real
evidence (env config, the catalog, the recorded seller profile, recent reconciliation runs, and —
with `--live` — a real Stripe Accounts API call) and calls it; that separation keeps the actual
pass/fail decision testable without needing a live Stripe account to write a test for it.

## Running the check

```sh
pnpm billing:check-readiness
```

Read-only by default: it never calls the real Stripe API unless you pass `--live` (still read-only —
it only retrieves the connected account's `charges_enabled` flag). Three gates require an explicit
operator attestation rather than a computed check, because none can be verified from source or a
database row:

```sh
pnpm billing:check-readiness --live --confirm-terms-privacy --confirm-runbooks --confirm-portal-configuration
```

Only pass `--confirm-terms-privacy` once the current `CURRENT_CONSENT_VERSIONS` (`src/shared/lib/legal.ts`)
have actually been reviewed for this launch, `--confirm-runbooks` once the incident,
secret-rotation, refund, and backup/restore runbooks referenced in the launch register have a real
tabletop exercise on record, and `--confirm-portal-configuration` once the Stripe Billing Portal
configuration actually in use (Stripe Dashboard → Settings → Billing → Customer portal, or a specific
Configuration id `src/shared/lib/billing/portal.ts` passes) has been checked to restrict the owner to
payment methods, tax identity, invoices, and receipts only — no plan switching, no cancellation.
Passing any flag without that evidence existing defeats the entire point of a fail-closed gate —
these are attestations, not checkboxes to clear.

Exit code is `0` when `ready: true`, `1` otherwise. Output is a JSON object naming exactly which
gates are unmet (`missing`) — the reason codes are the evidence struct's own field names, never a
secret value, so this is always safe to paste into an incident channel or a release ticket.

## The gates

| Gate | What it means | How it's checked |
| --- | --- | --- |
| `billingFlagEnabledInLiveMode` | The on/off switch itself: `STRIPE_BILLING_ENABLED=true` with a live secret key. | `process.env` |
| `chargesEnabled` | Stripe KYC is complete and the account can accept real charges. | Stripe Accounts API (`--live` only) |
| `sellerProfileRecorded` | A seller profile version exists with legal name, address, and country. | `getCurrentSellerProfile()` |
| `supportContactConfigured` | The current seller profile's statement descriptor and support email are both set. | `getCurrentSellerProfile()` |
| `catalogLivePriceIdsComplete` | Every currently-active catalog entry has a real, non-null live Stripe Price ID. | `src/shared/lib/billing/catalog.ts` |
| `webhookAndApiVersionConfigured` | `STRIPE_WEBHOOK_SECRET` and `STRIPE_API_VERSION` are both set. | `process.env` |
| `webhookPayloadEncryptionKeyConfigured` | `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` is set to 64 hex characters — without it, every real webhook receipt throws before it can even be stored. | `process.env` |
| `taxConfigurationRecorded` | At least one tax registration is on file. | `getCurrentSellerProfile()` |
| `denmarkAllowlisted` | The production customer-country allowlist includes Denmark. | `getCurrentSellerProfile()` |
| `termsPrivacyVersionsConfirmed` | An operator has confirmed the current Terms/Privacy versions were reviewed for this launch. | `--confirm-terms-privacy` |
| `operatorRunbooksConfirmed` | Incident/secret-rotation/refund/restore runbooks exist and have a tabletop exercise on record. | `--confirm-runbooks` |
| `reconciliationEvidenceRecent` | A `billing_reconciliation_runs` row with `result: 'clean'` exists within the last 48 hours. | `billing_reconciliation_runs` |
| `portalConfigurationRestricted` | The Stripe Billing Portal configuration in use restricts the owner to payment methods, tax identity, invoices, and receipts — no plan switching or cancellation. | `--confirm-portal-configuration` |

## Known gaps, tracked deliberately rather than hidden

- **`taxConfigurationRecorded`** is a proxy — "at least one tax registration is on file" — not a
  real check that the Stripe Tax product tax code (`provision-stripe-catalog.ts`'s `TAX_CODE`
  constant) matches what's actually configured in the live Stripe account. No separate
  product-tax-code store exists yet; tighten this gate if one is added.
- **Three checklist items in `stripe-launch-register.md` have no corresponding gate at all**
  because this script cannot verify them from source, a database row, or a single API call: the
  signed-webhook duplicate/reordered/delayed/invalid-signature test matrix, the credit-ledger
  property/concurrency tests, and the monthly/annual Test Clock lifecycle matrix. These remain
  pass/fail facts an operator must confirm separately (e.g. a CI job or a manual test run) before
  flipping `STRIPE_BILLING_ENABLED` in production — this gate covers configuration/evidence
  readiness, not "every test suite has been run."
- **The Denmark canary** (one real voluntary customer, one successful charge/refund/reconciliation
  cycle) is inherently something that can only happen after live mode is already partially enabled,
  so it is explicitly out of scope for a pre-flight gate — track it as the final launch-register item
  it already is. **Narrowed 2026-08-04**: seven of its nine observations turned out not to need live
  mode at all and are now certified against real test-mode Stripe — see `stripe-live-rollout.md` for
  the split and the evidence. Only the real charge and the payout/FX facts remain live-only.
