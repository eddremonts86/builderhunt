/**
 * Pure, importable comparison between a `catalog.ts` entry and the real Stripe `Price` object it's
 * supposed to correspond to (plans/phase-1/29-stripe-billing-platform/tasks.md §1 "Validate Stripe Products and
 * Prices before mutation"). Extracted out of `scripts/billing/provision-stripe-catalog.ts`, which
 * used to inline this logic with no dedicated test coverage — this module is now the single place
 * that decides "does this real Stripe object match what the catalog claims," and the provisioning
 * script imports it rather than re-implementing it.
 *
 * Every diff message is built only from catalog/Price data (amounts, ids, currencies, metadata) —
 * never a Stripe secret key or any other credential — so a diagnostic is always safe to paste into
 * an incident channel or a release ticket, matching the same "reason codes never leak secrets"
 * convention as `billing/readiness.ts`.
 */
import type Stripe from 'stripe'
import type { PackCatalogEntry, SubscriptionCatalogEntry } from './catalog'

export class CatalogMismatchError extends Error {
  constructor(public readonly key: string, public readonly diffs: string[]) {
    super(`Existing Stripe object for "${key}" does not match catalog — refusing to mutate:\n  - ${diffs.join('\n  - ')}`)
    this.name = 'CatalogMismatchError'
  }
}

export function intervalOf(entry: SubscriptionCatalogEntry): 'month' | 'year' {
  return entry.interval === 'annual' ? 'year' : 'month'
}

function productIdOf(price: Stripe.Price): string | undefined {
  return typeof price.product === 'string' ? price.product : price.product?.id
}

/** Compares only the metadata keys the provisioning script itself writes — an extra key on the Price is not a mismatch, a missing or wrong one is. */
function diffMetadata(expected: Record<string, string>, actual: Stripe.Metadata | null | undefined): string[] {
  const diffs: string[] = []
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual?.[field]
    if (actualValue !== expectedValue) diffs.push(`metadata.${field} ${JSON.stringify(actualValue)} ≠ ${JSON.stringify(expectedValue)}`)
  }
  return diffs
}

export function subscriptionMetadataOf(entry: SubscriptionCatalogEntry): Record<string, string> {
  return {
    catalog_key: entry.key,
    catalog_version: String(entry.version),
    tier: entry.tier,
    interval: entry.interval,
    monthly_credits: String(entry.monthlyCredits),
    seat_limit: String(entry.seatLimit),
    kind: 'subscription',
  }
}

export function packMetadataOf(entry: PackCatalogEntry): Record<string, string> {
  return {
    catalog_key: entry.key,
    catalog_version: String(entry.version),
    credits: String(entry.credits),
    expiry_months: String(entry.expiryMonths),
    kind: 'pack',
  }
}

export interface ValidatePriceOptions {
  /** Whether the caller expects this Price to belong to Stripe's live account (a live Price fetched while expecting test — or vice versa — is a real, fail-closed mismatch, not something to silently accept). */
  expectedLivemode: boolean
}

/** Returns every divergence between `entry` and the real `price`/`productId` — empty array means "matches exactly." Never throws; the caller decides whether to turn a non-empty result into a `CatalogMismatchError`. */
export function diffSubscriptionPrice(
  entry: SubscriptionCatalogEntry,
  price: Stripe.Price,
  productId: string,
  options: ValidatePriceOptions,
): string[] {
  const diffs: string[] = []
  if (price.unit_amount !== entry.amountCents) diffs.push(`unit_amount ${price.unit_amount} ≠ ${entry.amountCents}`)
  if (price.currency !== entry.currency) diffs.push(`currency ${price.currency} ≠ ${entry.currency}`)
  if (price.tax_behavior !== entry.taxBehavior) diffs.push(`tax_behavior ${price.tax_behavior} ≠ ${entry.taxBehavior}`)
  if (price.type !== 'recurring') diffs.push(`type ${price.type} ≠ recurring`)
  if (price.recurring?.interval !== intervalOf(entry)) diffs.push(`interval ${price.recurring?.interval} ≠ ${intervalOf(entry)}`)
  if ((price.recurring?.interval_count ?? 1) !== 1) diffs.push(`interval_count ${price.recurring?.interval_count} ≠ 1`)
  const prodId = productIdOf(price)
  if (prodId !== productId) diffs.push(`product ${prodId} ≠ ${productId}`)
  if (!price.active) diffs.push('price is archived/inactive')
  if (price.livemode !== options.expectedLivemode) diffs.push(`livemode ${price.livemode} ≠ ${options.expectedLivemode}`)
  diffs.push(...diffMetadata(subscriptionMetadataOf(entry), price.metadata))
  return diffs
}

export function diffPackPrice(
  entry: PackCatalogEntry,
  price: Stripe.Price,
  productId: string,
  options: ValidatePriceOptions,
): string[] {
  const diffs: string[] = []
  if (price.unit_amount !== entry.amountCents) diffs.push(`unit_amount ${price.unit_amount} ≠ ${entry.amountCents}`)
  if (price.currency !== entry.currency) diffs.push(`currency ${price.currency} ≠ ${entry.currency}`)
  if (price.tax_behavior !== entry.taxBehavior) diffs.push(`tax_behavior ${price.tax_behavior} ≠ ${entry.taxBehavior}`)
  if (price.type !== 'one_time') diffs.push(`type ${price.type} ≠ one_time`)
  const prodId = productIdOf(price)
  if (prodId !== productId) diffs.push(`product ${prodId} ≠ ${productId}`)
  if (!price.active) diffs.push('price is archived/inactive')
  if (price.livemode !== options.expectedLivemode) diffs.push(`livemode ${price.livemode} ≠ ${options.expectedLivemode}`)
  diffs.push(...diffMetadata(packMetadataOf(entry), price.metadata))
  return diffs
}

/** Throws `CatalogMismatchError` if `price`/`productId` diverge from `entry` in any way; otherwise returns silently. */
export function validateSubscriptionPrice(entry: SubscriptionCatalogEntry, price: Stripe.Price, productId: string, options: ValidatePriceOptions): void {
  const diffs = diffSubscriptionPrice(entry, price, productId, options)
  if (diffs.length) throw new CatalogMismatchError(entry.key, diffs)
}

export function validatePackPrice(entry: PackCatalogEntry, price: Stripe.Price, productId: string, options: ValidatePriceOptions): void {
  const diffs = diffPackPrice(entry, price, productId, options)
  if (diffs.length) throw new CatalogMismatchError(entry.key, diffs)
}
