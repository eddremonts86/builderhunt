import { describe, expect, it } from 'vitest'
import { assessLiveBillingReadiness, type LiveBillingReadinessEvidence } from './readiness'

const FULLY_READY: LiveBillingReadinessEvidence = {
  billingFlagEnabledInLiveMode: true,
  chargesEnabled: true,
  sellerProfileRecorded: true,
  supportContactConfigured: true,
  catalogLivePriceIdsComplete: true,
  webhookAndApiVersionConfigured: true,
  taxConfigurationRecorded: true,
  denmarkAllowlisted: true,
  termsPrivacyVersionsConfirmed: true,
  operatorRunbooksConfirmed: true,
  reconciliationEvidenceRecent: true,
  portalConfigurationRestricted: true,
}

const GATES = Object.keys(FULLY_READY) as Array<keyof LiveBillingReadinessEvidence>

describe('assessLiveBillingReadiness', () => {
  it('is ready when a fully-populated sandbox fixture satisfies every gate', () => {
    expect(assessLiveBillingReadiness(FULLY_READY)).toEqual({ ready: true, missing: [] })
  })

  for (const gate of GATES) {
    it(`is not ready when only ${gate} is missing, and reports exactly that reason code`, () => {
      const evidence = { ...FULLY_READY, [gate]: false }
      const result = assessLiveBillingReadiness(evidence)
      expect(result.ready).toBe(false)
      expect(result.missing).toEqual([gate])
    })
  }

  it('reports every missing gate at once when nothing is configured', () => {
    const nothingConfigured = Object.fromEntries(GATES.map((gate) => [gate, false])) as Record<keyof LiveBillingReadinessEvidence, boolean>
    const result = assessLiveBillingReadiness(nothingConfigured)
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual(GATES)
  })

  it('never emits anything other than the evidence struct\'s own field names — no secret values can leak through a reason code', () => {
    const result = assessLiveBillingReadiness({ ...FULLY_READY, webhookAndApiVersionConfigured: false, chargesEnabled: false })
    for (const reason of result.missing) {
      expect(GATES).toContain(reason)
      expect(reason).not.toMatch(/sk_(test|live)_|whsec_/)
    }
  })
})
