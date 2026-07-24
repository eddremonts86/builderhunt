# Stripe Catalog Validation

> For how to actually run the provisioning script day to day (create the catalog, get Price IDs
> into `catalog.ts`, the archive-and-recreate procedure for changing a price), see
> `docs/operations/stripe-setup-guide.md` §3 — this doc does not duplicate that. This one is about
> what "matches the catalog" means and how it's enforced.

## What gets compared

`src/shared/lib/billing/catalog-validation.ts` is the single place that decides whether a real
Stripe `Price` object matches its corresponding `catalog.ts` entry. Both
`scripts/billing/provision-stripe-catalog.ts` (the operator-facing script) and this module's own
test suite (`catalog-validation.test.ts`) share it — the script never re-implements the comparison
itself, so the two can never silently drift apart.

Every one of these must match exactly, or the whole run refuses to mutate anything:

| Field | Compared against |
| --- | --- |
| `unit_amount` | `entry.amountCents` |
| `currency` | `entry.currency` |
| `tax_behavior` | `entry.taxBehavior` |
| `type` | `recurring` (subscriptions) / `one_time` (packs) |
| `recurring.interval` / `interval_count` | derived from `entry.interval` (subscriptions only) |
| `product` | the deterministic product id (`bh_sub_pro`, `bh_pack_starter_300`, etc.) |
| `active` | must be `true` — an archived Price is always a mismatch |
| `livemode` | the caller's `expectedLivemode` (from the secret key prefix) — catches a live Price ID somehow ending up compared against a test key, or vice versa |
| `metadata.*` | every key the provisioning script itself writes (`catalog_key`, `catalog_version`, `tier`/`interval`/`monthly_credits`/`seat_limit` for subscriptions, `credits`/`expiry_months` for packs, `kind`) |

A mismatch on any single field throws `CatalogMismatchError` naming every diff found (not just the
first) — the message is built only from catalog/Price data, never a secret, so it's always safe to
paste into an incident channel or release ticket.

## Why metadata and livemode are checked

The original version of this validation (before it was extracted into its own module) only checked
amount/currency/tax/interval/product/active — metadata was written on create but never diffed on
validate, and livemode wasn't checked at all. Both were real, silent gaps: a metadata field could
drift (e.g. a hand-edited Price in the Stripe Dashboard) and this script would report "ok,
unchanged" without ever looking. Both are now first-class comparisons with dedicated negative-fixture
tests (`catalog-validation.test.ts`).

## Running it for real

```sh
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --validate   # read-only, throws on any mismatch
```

Verified against the real Stripe test sandbox: all 9 catalog entries (6 subscription Prices, 3 pack
Prices) validate clean, including the metadata and livemode checks.
