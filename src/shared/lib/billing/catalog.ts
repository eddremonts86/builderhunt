/**
 * The immutable Stripe billing catalog (spec.md §Commercial contract). This
 * is a NEW, separate catalog from the legacy manual system in
 * `~/shared/lib/billing-shared.ts` (`PlanTier`/`PLAN_LIMITS`/`PLAN_PRICING`,
 * still `free | pro | team` at $0/$19/$99) — that system keeps serving
 * existing manually-billed organizations unchanged until the voluntary
 * migration in plans/stripe-billing-platform/tasks.md §10 ("Migrate manual
 * entitlements without charging") atomically moves an organization off it.
 * Do NOT mutate `PlanTier`/`PLAN_PRICING` to match this file — Team's price
 * changes ($99 → $199) and Pro Max is entirely new; existing subscribers on
 * the legacy price must keep it until their next eligible renewal (spec.md
 * §Commercial contract: "Increases receive at least 30 days' notice").
 *
 * Clients may only submit a `CatalogKey` (an opaque string) — never a price,
 * amount, currency, interval, or Stripe Price ID. The server resolves
 * everything else from this file.
 */

export type CatalogTier = 'free' | 'pro' | 'pro_max' | 'team'
export type CatalogInterval = 'monthly' | 'annual'

export type SubscriptionCatalogKey =
  | 'pro_monthly' | 'pro_annual'
  | 'pro_max_monthly' | 'pro_max_annual'
  | 'team_monthly' | 'team_annual'

export type PackCatalogKey = 'starter_300' | 'scale_1000' | 'max_5000'

export interface SubscriptionCatalogEntry {
  key: SubscriptionCatalogKey
  tier: Exclude<CatalogTier, 'free'>
  interval: CatalogInterval
  /** USD, smallest unit (cents) — spec.md's non-goal: no BuilderHunt-side currency conversion. */
  amountCents: number
  /** Credits granted per monthly window (annual grants this same amount 12 times, once per anniversary). */
  monthlyCredits: number
  seatLimit: number
  /** Catalog schema version — bump on any amount/interval/tax change; never mutate a released entry in place. */
  version: number
  currency: 'usd'
  /** Stripe Tax "automatic" behavior — amounts above are tax-exclusive (spec.md: "displayed as excluding applicable tax"). */
  taxBehavior: 'exclusive'
  /** Filled in once created in Stripe (task "Validate Stripe Products and Prices before mutation") — never invented locally. */
  stripePriceId: { test: string | null; live: string | null }
  effectiveAt: string
  retiredAt: string | null
}

export interface PackCatalogEntry {
  key: PackCatalogKey
  amountCents: number
  credits: number
  expiryMonths: 12
  version: number
  currency: 'usd'
  taxBehavior: 'exclusive'
  stripePriceId: { test: string | null; live: string | null }
  effectiveAt: string
  retiredAt: string | null
}

const EFFECTIVE_AT = '2026-07-23'

export const SUBSCRIPTION_CATALOG: Record<SubscriptionCatalogKey, SubscriptionCatalogEntry> = {
  pro_monthly: {
    key: 'pro_monthly', tier: 'pro', interval: 'monthly', amountCents: 1900, monthlyCredits: 140, seatLimit: 1,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQVFV1TKaJ4hmg4wESYRA', live: 'price_1TwfDPFbQx9fJlcGq5lrPtGz' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  pro_annual: {
    key: 'pro_annual', tier: 'pro', interval: 'annual', amountCents: 18200, monthlyCredits: 140, seatLimit: 1,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQVFV1TKaJ4hmSrIQtfDl', live: 'price_1TwfDPFbQx9fJlcGr9njS4a5' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  pro_max_monthly: {
    key: 'pro_max_monthly', tier: 'pro_max', interval: 'monthly', amountCents: 7900, monthlyCredits: 700, seatLimit: 1,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQWFV1TKaJ4hms2z9CyNc', live: 'price_1TwfDQFbQx9fJlcG4YFpbzb2' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  pro_max_annual: {
    key: 'pro_max_annual', tier: 'pro_max', interval: 'annual', amountCents: 75800, monthlyCredits: 700, seatLimit: 1,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQXFV1TKaJ4hm7dgeuzZO', live: 'price_1TwfDRFbQx9fJlcGqjoqti5M' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  team_monthly: {
    key: 'team_monthly', tier: 'team', interval: 'monthly', amountCents: 19900, monthlyCredits: 2100, seatLimit: 10,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQYFV1TKaJ4hmoseJQE1o', live: 'price_1TwfDSFbQx9fJlcG1jAyebwz' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  team_annual: {
    key: 'team_annual', tier: 'team', interval: 'annual', amountCents: 191000, monthlyCredits: 2100, seatLimit: 10,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQYFV1TKaJ4hmHjdL2IX3', live: 'price_1TwfDSFbQx9fJlcGGu9dLNKz' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
}

export const PACK_CATALOG: Record<PackCatalogKey, PackCatalogEntry> = {
  starter_300: {
    key: 'starter_300', amountCents: 1500, credits: 300, expiryMonths: 12,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQZFV1TKaJ4hmws9hYFGH', live: 'price_1TwfDTFbQx9fJlcG3Uzc83pg' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  scale_1000: {
    key: 'scale_1000', amountCents: 4500, credits: 1000, expiryMonths: 12,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQaFV1TKaJ4hmoGRpN32j', live: 'price_1TwfDUFbQx9fJlcGqGSlhriD' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
  max_5000: {
    key: 'max_5000', amountCents: 29900, credits: 5000, expiryMonths: 12,
    version: 1, currency: 'usd', taxBehavior: 'exclusive', stripePriceId: { test: 'price_1TwKQbFV1TKaJ4hmjxAhqdqJ', live: 'price_1TwfDVFbQx9fJlcGytb38ChQ' },
    effectiveAt: EFFECTIVE_AT, retiredAt: null,
  },
}

/**
 * Every field a `CatalogTier` must define — the `Record<CatalogTier, ...>`
 * shape below fails to compile if a tier is missing, satisfying "exhaustive
 * TypeScript checks fail when a tier lacks pricing, entitlement, icon, or
 * limits" without a runtime test.
 */
export interface TierPresentation {
  label: string
  icon: string
  features: string[]
}

export const TIER_PRESENTATION: Record<CatalogTier, TierPresentation> = {
  free: {
    label: 'Free', icon: 'sparkles',
    features: ['3 saved searches', '50 saved builders', 'Basic RSS feeds', 'Public /explore', 'Public /blog'],
  },
  pro: {
    label: 'Pro', icon: 'zap',
    features: ['50 saved searches', 'Unlimited saved builders', 'Smart alerts', 'Semantic search', '140 credits/month', 'Priority support'],
  },
  pro_max: {
    label: 'Pro Max', icon: 'rocket',
    features: ['Everything in Pro', '700 credits/month', 'AI sourcing sprints (up to 3)', 'Work-sample analysis', 'Priority support'],
  },
  team: {
    label: 'Team', icon: 'users',
    features: ['Everything in Pro Max', 'Up to 10 team seats', '2,100 pooled credits/month', 'Shared saved searches', 'Shared builder lists', 'Activity feed', 'AI sourcing sprints (up to 10)'],
  },
}

/** Client-safe projection — no Stripe Price ID, no internal version/tax-behavior plumbing. */
export interface SubscriptionCatalogDto {
  key: SubscriptionCatalogKey
  tier: Exclude<CatalogTier, 'free'>
  interval: CatalogInterval
  amountCents: number
  currency: 'usd'
  monthlyCredits: number
  seatLimit: number
}

export interface PackCatalogDto {
  key: PackCatalogKey
  amountCents: number
  currency: 'usd'
  credits: number
  expiryMonths: number
}

export function isActive(entry: { effectiveAt: string; retiredAt: string | null }, now: Date): boolean {
  return new Date(entry.effectiveAt) <= now && (entry.retiredAt === null || new Date(entry.retiredAt) > now)
}

export function toSubscriptionCatalogDto(entry: SubscriptionCatalogEntry): SubscriptionCatalogDto {
  return {
    key: entry.key,
    tier: entry.tier,
    interval: entry.interval,
    amountCents: entry.amountCents,
    currency: entry.currency,
    monthlyCredits: entry.monthlyCredits,
    seatLimit: entry.seatLimit,
  }
}

export function toPackCatalogDto(entry: PackCatalogEntry): PackCatalogDto {
  return { key: entry.key, amountCents: entry.amountCents, currency: entry.currency, credits: entry.credits, expiryMonths: entry.expiryMonths }
}

/** Every currently-purchasable subscription entry, as client-safe DTOs. Server-only fields (Price ID, version) never leave this module. */
export function listActiveSubscriptionCatalog(now: Date = new Date()): SubscriptionCatalogDto[] {
  return Object.values(SUBSCRIPTION_CATALOG).filter((entry) => isActive(entry, now)).map(toSubscriptionCatalogDto)
}

export function listActivePackCatalog(now: Date = new Date()): PackCatalogDto[] {
  return Object.values(PACK_CATALOG).filter((entry) => isActive(entry, now)).map(toPackCatalogDto)
}

/** Resolves a client-submitted catalog key to its full server-side entry, or null if unknown/retired. Never trust a client-submitted amount/Price ID/tier — always re-derive from this. */
export function resolveSubscriptionCatalogKey(key: string, now: Date = new Date()): SubscriptionCatalogEntry | null {
  const entry = (SUBSCRIPTION_CATALOG as Record<string, SubscriptionCatalogEntry>)[key]
  if (!entry || !isActive(entry, now)) return null
  return entry
}

export function resolvePackCatalogKey(key: string, now: Date = new Date()): PackCatalogEntry | null {
  const entry = (PACK_CATALOG as Record<string, PackCatalogEntry>)[key]
  if (!entry || !isActive(entry, now)) return null
  return entry
}

/**
 * Unfiltered counterpart to `resolvePackCatalogKey` — mirrors
 * `resolveSubscriptionCatalogEntryByKey`'s reasoning: a pack grant already on the ledger (read back
 * via its `sourceReference`, e.g. by the rolling risk-limit check in `billing/packs.ts`) must keep
 * resolving its original price even after that pack entry is retired from new purchases. Never call
 * this with a client-submitted key.
 */
export function resolvePackCatalogEntryByKey(key: string): PackCatalogEntry | null {
  return (PACK_CATALOG as Record<string, PackCatalogEntry>)[key] ?? null
}

/**
 * Unfiltered counterpart to `resolveSubscriptionCatalogKey` — an EXISTING subscription's own
 * recorded catalog key (e.g. read back from `billing_subscriptions.catalog_key` for an
 * `invoice.paid` credit grant) must keep resolving even after that entry is retired from new
 * signups; retirement blocks new Checkout attempts, not recognition of an already-active
 * subscriber's own plan. Never call this with a client-submitted key.
 */
export function resolveSubscriptionCatalogEntryByKey(key: string): SubscriptionCatalogEntry | null {
  return (SUBSCRIPTION_CATALOG as Record<string, SubscriptionCatalogEntry>)[key] ?? null
}

/**
 * The reverse direction of `resolveSubscriptionCatalogKey` — given a Stripe Price ID a webhook
 * event carries (never a client-submitted value; this is only ever called with an id read back
 * from Stripe's own object), finds which catalog entry it belongs to. Checks retired entries too
 * (`isActive` is NOT applied here): an existing subscriber must keep resolving correctly against a
 * Price that was later retired from new signups — retirement blocks new Checkout attempts, not
 * recognition of an already-active subscription's own Price.
 */
export function resolveSubscriptionCatalogEntryByStripePriceId(priceId: string, livemode: boolean): SubscriptionCatalogEntry | null {
  const key = livemode ? 'live' : 'test'
  return Object.values(SUBSCRIPTION_CATALOG).find((entry) => entry.stripePriceId[key] === priceId) ?? null
}
