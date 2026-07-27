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

const { getSolutionsFeatureFlags, SOLUTIONS_RATE_CARD_KEYS, SOLUTIONS_ENTITLEMENT_TIERS } = await import('~/shared/lib/solutions/config')

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

describe('SOLUTIONS_RATE_CARD_KEYS', () => {
  it('declares the exact fixed units from spec.md', () => {
    expect(SOLUTIONS_RATE_CARD_KEYS.generate).toEqual({ operationKey: 'solutions.generate.v1', version: 1, units: 10 })
    expect(SOLUTIONS_RATE_CARD_KEYS.regenerate).toEqual({ operationKey: 'solutions.regenerate.v1', version: 1, units: 3 })
  })
})

describe('SOLUTIONS_ENTITLEMENT_TIERS', () => {
  it('excludes free — pro/pro_max/team only', () => {
    expect(SOLUTIONS_ENTITLEMENT_TIERS).toEqual(['pro', 'pro_max', 'team'])
  })
})
