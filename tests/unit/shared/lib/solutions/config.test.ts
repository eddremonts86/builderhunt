import { describe, expect, it, vi } from 'vitest'

// Same pattern as abuse/enforcement-kill-switch.test.ts: env.ts always uses its browser-stub
// branch under vitest's happy-dom environment (`typeof window !== 'undefined'` is always true),
// so `vi.stubEnv` alone can never change what `env.SOLUTIONS_*` resolves to in a test. Mocking
// the `env` module directly is the only way to exercise a non-default flag value.
const mockEnv = vi.hoisted(() => ({
  SOLUTIONS_CATALOG_INGESTION_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_PUBLIC_SCRAPE_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_LIVE_ENRICHMENT_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_INTERPRETATION_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_EXPLANATION_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_EXTERNAL_HUMAN_ENABLED: 'false' as 'true' | 'false',
  SOLUTIONS_PAID_GENERATION_ENABLED: 'false' as 'true' | 'false',
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { getSolutionsFeatureFlags, getSolutionsRateCardKey, listSolutionsRateCardKeys, SOLUTIONS_ENTITLEMENT_TIERS } = await import('~/shared/lib/solutions/config')
const { RATE_CARDS } = await import('~/shared/lib/billing/rate-cards')

describe('getSolutionsFeatureFlags', () => {
  it('defaults every flag to false', () => {
    expect(getSolutionsFeatureFlags()).toEqual({
      catalogIngestionEnabled: false,
      publicScrapeEnabled: false,
      liveEnrichmentEnabled: false,
      interpretationEnabled: false,
      explanationEnabled: false,
      externalHumanEnabled: false,
      paidGenerationEnabled: false,
    })
  })

  it('each flag turns on independently without affecting the others', () => {
    mockEnv.SOLUTIONS_INTERPRETATION_ENABLED = 'true'
    try {
      const flags = getSolutionsFeatureFlags()
      expect(flags.interpretationEnabled).toBe(true)
      expect(flags.paidGenerationEnabled).toBe(false)
      expect(flags.catalogIngestionEnabled).toBe(false)
    } finally {
      mockEnv.SOLUTIONS_INTERPRETATION_ENABLED = 'false'
    }
  })
})

describe('getSolutionsRateCardKey', () => {
  it('resolves the exact fixed units from spec.md', () => {
    // The operation *names* are the registry's snake_case identifiers rather than spec.md's
    // `solutions.generate.v1`; the version moved into the card's own field. The numbers are spec.md's.
    expect(getSolutionsRateCardKey('generate')).toEqual({ operationKey: 'solutions_generate', version: 1, units: 10 })
    expect(getSolutionsRateCardKey('regenerate')).toEqual({ operationKey: 'solutions_regenerate', version: 1, units: 3 })
    expect(listSolutionsRateCardKeys().generate.units).toBe(10)
  })

  it('refuses an operation it does not know', () => {
    // Not a silent undefined: the caller is about to reserve credits with whatever comes back.
    expect(() => getSolutionsRateCardKey('generate_v2')).toThrow(/Unknown solutions rate-card operation/)
  })

  it('follows a registry price change without a restart', () => {
    // A snapshot taken at module load would have let two servers mid-deploy quote different prices for the
    // same operation.
    const original = { ...RATE_CARDS.solutions_generate }
    RATE_CARDS.solutions_generate = { ...original, version: 2, maxUnits: 14 }
    try {
      expect(getSolutionsRateCardKey('generate')).toEqual({ operationKey: 'solutions_generate', version: 2, units: 14 })
    } finally {
      RATE_CARDS.solutions_generate = original
    }
  })

  it('reports a deregistered operation as unregistered rather than mispricing it', () => {
    const original = RATE_CARDS.solutions_regenerate
    delete RATE_CARDS.solutions_regenerate
    try {
      expect(() => getSolutionsRateCardKey('regenerate')).toThrow(/is not registered/)
    } finally {
      RATE_CARDS.solutions_regenerate = original
    }
  })
})

describe('SOLUTIONS_ENTITLEMENT_TIERS', () => {
  it('excludes free — pro/pro_max/team only', () => {
    expect(SOLUTIONS_ENTITLEMENT_TIERS).toEqual(['pro', 'pro_max', 'team'])
  })
})
