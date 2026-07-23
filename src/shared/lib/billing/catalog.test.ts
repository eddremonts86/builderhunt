import { describe, expect, it } from 'vitest'
import { PLAN_PRICING } from '../billing-shared'
import {
  isActive,
  listActivePackCatalog,
  listActiveSubscriptionCatalog,
  PACK_CATALOG,
  resolvePackCatalogKey,
  resolveSubscriptionCatalogKey,
  SUBSCRIPTION_CATALOG,
  TIER_PRESENTATION,
  toPackCatalogDto,
  toSubscriptionCatalogDto,
} from './catalog'

// "Exhaustive TypeScript checks fail when a tier lacks pricing, entitlement,
// icon, or limits" (task verify criterion) is enforced at compile time by
// TIER_PRESENTATION's `Record<CatalogTier, TierPresentation>` annotation in
// catalog.ts, and by SUBSCRIPTION_CATALOG's `Record<SubscriptionCatalogKey,
// ...>` — removing a tier/key from either object fails `pnpm type-check`,
// not this test file. These tests pin the runtime values instead.

describe('subscription catalog — exact amounts from spec.md', () => {
  it('prices Pro at $19/month, $182/year, 140 monthly credits', () => {
    expect(SUBSCRIPTION_CATALOG.pro_monthly).toMatchObject({ tier: 'pro', amountCents: 1900, monthlyCredits: 140, seatLimit: 1 })
    expect(SUBSCRIPTION_CATALOG.pro_annual).toMatchObject({ tier: 'pro', amountCents: 18200, monthlyCredits: 140, seatLimit: 1 })
  })

  it('prices Pro Max at $79/month, $758/year, 700 monthly credits', () => {
    expect(SUBSCRIPTION_CATALOG.pro_max_monthly).toMatchObject({ tier: 'pro_max', amountCents: 7900, monthlyCredits: 700, seatLimit: 1 })
    expect(SUBSCRIPTION_CATALOG.pro_max_annual).toMatchObject({ tier: 'pro_max', amountCents: 75800, monthlyCredits: 700, seatLimit: 1 })
  })

  it('prices Team at $199/month, $1,910/year, 2,100 pooled monthly credits, 10 seats', () => {
    expect(SUBSCRIPTION_CATALOG.team_monthly).toMatchObject({ tier: 'team', amountCents: 19900, monthlyCredits: 2100, seatLimit: 10 })
    expect(SUBSCRIPTION_CATALOG.team_annual).toMatchObject({ tier: 'team', amountCents: 191000, monthlyCredits: 2100, seatLimit: 10 })
  })

  it('every entry is USD, tax-exclusive, version 1, with no Stripe Price ID yet', () => {
    for (const entry of Object.values(SUBSCRIPTION_CATALOG)) {
      expect(entry.currency).toBe('usd')
      expect(entry.taxBehavior).toBe('exclusive')
      expect(entry.version).toBe(1)
      expect(entry.stripePriceId).toEqual({ test: null, live: null })
    }
  })
})

describe('pack catalog — exact amounts from spec.md', () => {
  it('prices starter_300 at $15 for 300 credits', () => {
    expect(PACK_CATALOG.starter_300).toMatchObject({ amountCents: 1500, credits: 300, expiryMonths: 12 })
  })

  it('prices scale_1000 at $45 for 1,000 credits', () => {
    expect(PACK_CATALOG.scale_1000).toMatchObject({ amountCents: 4500, credits: 1000, expiryMonths: 12 })
  })

  it('prices max_5000 at $299 for 5,000 credits', () => {
    expect(PACK_CATALOG.max_5000).toMatchObject({ amountCents: 29900, credits: 5000, expiryMonths: 12 })
  })
})

describe('client-safe DTOs never carry server-only fields', () => {
  it('strips Stripe Price ID and version from a subscription entry', () => {
    const dto = toSubscriptionCatalogDto(SUBSCRIPTION_CATALOG.pro_monthly)
    expect(dto).not.toHaveProperty('stripePriceId')
    expect(dto).not.toHaveProperty('version')
    expect(dto).not.toHaveProperty('taxBehavior')
    expect(dto).toEqual({ key: 'pro_monthly', tier: 'pro', interval: 'monthly', amountCents: 1900, currency: 'usd', monthlyCredits: 140, seatLimit: 1 })
  })

  it('strips Stripe Price ID and version from a pack entry', () => {
    const dto = toPackCatalogDto(PACK_CATALOG.starter_300)
    expect(dto).not.toHaveProperty('stripePriceId')
    expect(dto).not.toHaveProperty('version')
    expect(dto).toEqual({ key: 'starter_300', amountCents: 1500, currency: 'usd', credits: 300, expiryMonths: 12 })
  })

  it('lists every active entry as a DTO', () => {
    expect(listActiveSubscriptionCatalog()).toHaveLength(Object.keys(SUBSCRIPTION_CATALOG).length)
    expect(listActivePackCatalog()).toHaveLength(Object.keys(PACK_CATALOG).length)
  })
})

describe('resolving a client-submitted catalog key', () => {
  it('resolves a known, active subscription key to its full entry', () => {
    expect(resolveSubscriptionCatalogKey('team_monthly')?.amountCents).toBe(19900)
  })

  it('resolves a known, active pack key to its full entry', () => {
    expect(resolvePackCatalogKey('max_5000')?.credits).toBe(5000)
  })

  it('returns null for an unknown key — never falls back to a default price', () => {
    expect(resolveSubscriptionCatalogKey('enterprise_monthly')).toBeNull()
    expect(resolvePackCatalogKey('mega_pack')).toBeNull()
  })

  it('returns null for a not-yet-effective entry', () => {
    expect(resolveSubscriptionCatalogKey('pro_monthly', new Date('2020-01-01'))).toBeNull()
  })

  it('treats a retired entry as inactive as of any date after retirement', () => {
    const retired = { effectiveAt: '2025-01-01', retiredAt: '2026-01-01' }
    expect(isActive(retired, new Date('2025-06-01'))).toBe(true)
    expect(isActive(retired, new Date('2026-06-01'))).toBe(false)
  })
})

describe('every tier has a presentation (label, icon, features)', () => {
  it.each(Object.keys(TIER_PRESENTATION) as (keyof typeof TIER_PRESENTATION)[])('%s has a non-empty label, icon, and feature list', (tier) => {
    const presentation = TIER_PRESENTATION[tier]
    expect(presentation.label.length).toBeGreaterThan(0)
    expect(presentation.icon.length).toBeGreaterThan(0)
    expect(presentation.features.length).toBeGreaterThan(0)
  })
})

describe('reconciliation with the legacy manual system (billing-shared.ts)', () => {
  it('does NOT match the legacy Team price — this is an intentional repricing for new Stripe subscribers, not a bug (spec.md: existing subscribers keep their contracted price until renewal)', () => {
    expect(PLAN_PRICING.team.monthly).toBe(99)
    expect(SUBSCRIPTION_CATALOG.team_monthly.amountCents).toBe(19900)
    expect(PLAN_PRICING.team.monthly * 100).not.toBe(SUBSCRIPTION_CATALOG.team_monthly.amountCents)
  })

  it('matches the legacy Pro price exactly — no unintentional drift', () => {
    expect(PLAN_PRICING.pro.monthly * 100).toBe(SUBSCRIPTION_CATALOG.pro_monthly.amountCents)
    expect(PLAN_PRICING.pro.annual * 100).toBe(SUBSCRIPTION_CATALOG.pro_annual.amountCents)
  })

  it('Pro Max has no legacy equivalent — new tier, no reconciliation possible', () => {
    expect('pro_max' in PLAN_PRICING).toBe(false)
  })
})
