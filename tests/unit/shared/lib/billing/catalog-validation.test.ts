import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SUBSCRIPTION_CATALOG, PACK_CATALOG } from '~/shared/lib/billing/catalog'
import {
  CatalogMismatchError,
  diffPackPrice,
  diffSubscriptionPrice,
  packMetadataOf,
  subscriptionMetadataOf,
  validatePackPrice,
  validateSubscriptionPrice,
} from '~/shared/lib/billing/catalog-validation'

const SUB_ENTRY = SUBSCRIPTION_CATALOG.pro_monthly
const SUB_PRODUCT_ID = 'bh_sub_pro'
const PACK_ENTRY = PACK_CATALOG.starter_300
const PACK_PRODUCT_ID = 'bh_pack_starter_300'

/** A Price object shaped to match SUB_ENTRY exactly — each test mutates exactly one field off of this baseline. */
function matchingSubscriptionPrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_test123',
    object: 'price',
    active: true,
    currency: SUB_ENTRY.currency,
    livemode: false,
    metadata: subscriptionMetadataOf(SUB_ENTRY),
    product: SUB_PRODUCT_ID,
    tax_behavior: SUB_ENTRY.taxBehavior,
    type: 'recurring',
    unit_amount: SUB_ENTRY.amountCents,
    recurring: { interval: 'month', interval_count: 1, trial_period_days: null, usage_type: 'licensed', meter: null },
    ...overrides,
  } as Stripe.Price
}

function matchingPackPrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_pack123',
    object: 'price',
    active: true,
    currency: PACK_ENTRY.currency,
    livemode: false,
    metadata: packMetadataOf(PACK_ENTRY),
    product: PACK_PRODUCT_ID,
    tax_behavior: PACK_ENTRY.taxBehavior,
    type: 'one_time',
    unit_amount: PACK_ENTRY.amountCents,
    recurring: null,
    ...overrides,
  } as Stripe.Price
}

describe('subscription price validation', () => {
  it('matches exactly and produces zero diffs', () => {
    expect(diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice(), SUB_PRODUCT_ID, { expectedLivemode: false })).toEqual([])
    expect(() => validateSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice(), SUB_PRODUCT_ID, { expectedLivemode: false })).not.toThrow()
  })

  it('fails on a wrong amount', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ unit_amount: SUB_ENTRY.amountCents + 100 }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('unit_amount'))
  })

  it('fails on a wrong interval', () => {
    const wrongInterval = matchingSubscriptionPrice({ recurring: { interval: 'year', interval_count: 1, trial_period_days: null, usage_type: 'licensed', meter: null } })
    const diffs = diffSubscriptionPrice(SUB_ENTRY, wrongInterval, SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('interval'))
  })

  it('fails on a wrong currency', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ currency: 'eur' }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('currency'))
  })

  it('fails on a wrong product', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ product: 'bh_sub_wrong' }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('product'))
  })

  it('fails on wrong metadata', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ metadata: { ...subscriptionMetadataOf(SUB_ENTRY), tier: 'team' } }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('metadata.tier'))
  })

  it('fails on a missing metadata field entirely', () => {
    const { catalog_key: _drop, ...rest } = subscriptionMetadataOf(SUB_ENTRY)
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ metadata: rest }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('metadata.catalog_key'))
  })

  it('fails on wrong livemode (a live Price fetched while expecting test, or vice versa)', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ livemode: true }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('livemode'))
  })

  it('fails on an archived/inactive price', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ active: false }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual('price is archived/inactive')
  })

  it('fails on a non-recurring price', () => {
    const diffs = diffSubscriptionPrice(SUB_ENTRY, matchingSubscriptionPrice({ type: 'one_time' }), SUB_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('type'))
  })

  it('throws CatalogMismatchError with every diff joined, never a secret value', () => {
    const bad = matchingSubscriptionPrice({ unit_amount: 1, currency: 'eur' })
    try {
      validateSubscriptionPrice(SUB_ENTRY, bad, SUB_PRODUCT_ID, { expectedLivemode: false })
      expect.fail('expected validateSubscriptionPrice to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogMismatchError)
      const mismatch = error as CatalogMismatchError
      expect(mismatch.key).toBe(SUB_ENTRY.key)
      expect(mismatch.diffs.length).toBeGreaterThanOrEqual(2)
      expect(mismatch.message).not.toMatch(/sk_(test|live)_|whsec_/)
    }
  })
})

describe('pack price validation', () => {
  it('matches exactly and produces zero diffs', () => {
    expect(diffPackPrice(PACK_ENTRY, matchingPackPrice(), PACK_PRODUCT_ID, { expectedLivemode: false })).toEqual([])
    expect(() => validatePackPrice(PACK_ENTRY, matchingPackPrice(), PACK_PRODUCT_ID, { expectedLivemode: false })).not.toThrow()
  })

  it('fails on a wrong amount', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ unit_amount: PACK_ENTRY.amountCents + 1 }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('unit_amount'))
  })

  it('fails on a wrong currency', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ currency: 'gbp' }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('currency'))
  })

  it('fails on a wrong product', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ product: 'bh_pack_wrong' }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('product'))
  })

  it('fails on wrong metadata', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ metadata: { ...packMetadataOf(PACK_ENTRY), credits: '999999' } }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('metadata.credits'))
  })

  it('fails on wrong livemode', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ livemode: true }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('livemode'))
  })

  it('fails on a recurring price (packs must be one_time)', () => {
    const diffs = diffPackPrice(PACK_ENTRY, matchingPackPrice({ type: 'recurring' }), PACK_PRODUCT_ID, { expectedLivemode: false })
    expect(diffs).toContainEqual(expect.stringContaining('type'))
  })

  it('throws CatalogMismatchError naming the pack key', () => {
    expect(() => validatePackPrice(PACK_ENTRY, matchingPackPrice({ unit_amount: 1 }), PACK_PRODUCT_ID, { expectedLivemode: false })).toThrow(CatalogMismatchError)
  })
})
