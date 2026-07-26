import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as reservations from '~/shared/lib/billing/reservations'
import * as credits from '~/shared/lib/billing/credits'
import {
  assertWithinMaxReservation,
  estimateBriefUnits,
  estimateReportUnits,
  estimateTranscriptionUnitsForSeconds,
  InterviewBillingError,
  MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES,
  maxLiveTranscriptionReservationUnits,
  normalizeProviderUsageVariance,
  resolveLowBalanceWarnings,
} from './billing'
import * as interviewBilling from './billing'

describe('estimateTranscriptionUnitsForSeconds', () => {
  it('rounds up a partial minute to a full minute of units', () => {
    expect(estimateTranscriptionUnitsForSeconds(1)).toBe(1)
    expect(estimateTranscriptionUnitsForSeconds(59)).toBe(1)
    expect(estimateTranscriptionUnitsForSeconds(60)).toBe(1)
    expect(estimateTranscriptionUnitsForSeconds(61)).toBe(2)
  })

  it('zero seconds costs zero units', () => {
    expect(estimateTranscriptionUnitsForSeconds(0)).toBe(0)
  })

  it('rejects negative or non-finite input', () => {
    expect(() => estimateTranscriptionUnitsForSeconds(-1)).toThrow(InterviewBillingError)
    expect(() => estimateTranscriptionUnitsForSeconds(Number.NaN)).toThrow()
    expect(() => estimateTranscriptionUnitsForSeconds(Number.POSITIVE_INFINITY)).toThrow()
  })

  it('property: units are always a non-negative integer, and rounding always rounds up (never down)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seconds) => {
        const units = estimateTranscriptionUnitsForSeconds(seconds)
        expect(Number.isInteger(units)).toBe(true)
        expect(units).toBeGreaterThanOrEqual(0)
        expect(units).toBeGreaterThanOrEqual(seconds / 60)
      }),
    )
  })
})

describe('estimateBriefUnits / estimateReportUnits', () => {
  it('pin the exact 5-credit flat costs from spec.md', () => {
    expect(estimateBriefUnits()).toBe(5)
    expect(estimateReportUnits()).toBe(5)
  })
})

describe('maximum reservation', () => {
  it('computes the maximum in units from the configured minute ceiling', () => {
    expect(maxLiveTranscriptionReservationUnits()).toBe(MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES)
  })

  it('accepts a request at or under the maximum', () => {
    expect(() => assertWithinMaxReservation(maxLiveTranscriptionReservationUnits())).not.toThrow()
    expect(() => assertWithinMaxReservation(1)).not.toThrow()
  })

  it('rejects a request over the maximum', () => {
    expect(() => assertWithinMaxReservation(maxLiveTranscriptionReservationUnits() + 1)).toThrow(InterviewBillingError)
  })

  it('property: any requested unit count over the max is always rejected', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (overshoot) => {
        expect(() => assertWithinMaxReservation(maxLiveTranscriptionReservationUnits() + overshoot)).toThrow()
      }),
    )
  })
})

describe('resolveLowBalanceWarnings', () => {
  it('warns at exactly 80% consumed', () => {
    const warnings = resolveLowBalanceWarnings({ reservedUnits: 100, consumedUnits: 80 })
    expect(warnings.map((w) => w.level)).toContain('eighty_percent')
    expect(warnings.map((w) => w.level)).not.toContain('ninety_percent')
  })

  it('warns at exactly 90% consumed, cumulatively including 80%', () => {
    const warnings = resolveLowBalanceWarnings({ reservedUnits: 100, consumedUnits: 90 })
    expect(warnings.map((w) => w.level)).toEqual(expect.arrayContaining(['eighty_percent', 'ninety_percent']))
  })

  it('warns at ten remaining minutes regardless of percentage consumed', () => {
    const warnings = resolveLowBalanceWarnings({ reservedUnits: 1000, consumedUnits: 991 })
    expect(warnings.map((w) => w.level)).toContain('ten_minutes_remaining')
  })

  it('issues no warnings when comfortably under every threshold', () => {
    expect(resolveLowBalanceWarnings({ reservedUnits: 1000, consumedUnits: 100 })).toEqual([])
  })

  it('rejects a non-positive reservedUnits (a boundary a real caller could pass)', () => {
    expect(() => resolveLowBalanceWarnings({ reservedUnits: 0, consumedUnits: 0 })).toThrow(InterviewBillingError)
    expect(() => resolveLowBalanceWarnings({ reservedUnits: -5, consumedUnits: 0 })).toThrow()
  })

  it('property: remainingUnits reported in a warning never exceeds reservedUnits and is never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (reservedUnits, consumedUnits) => {
          const warnings = resolveLowBalanceWarnings({ reservedUnits, consumedUnits })
          for (const warning of warnings) {
            expect(warning.remainingUnits).toBeGreaterThanOrEqual(0)
            expect(warning.remainingUnits).toBeLessThanOrEqual(reservedUnits)
          }
        },
      ),
    )
  })
})

describe('normalizeProviderUsageVariance', () => {
  it('reports zero variance for an exact match', () => {
    const result = normalizeProviderUsageVariance({ providerBilledSeconds: 60, estimatedUnits: 1 })
    expect(result.varianceRatio).toBe(0)
    expect(result.withinTolerance).toBe(true)
  })

  it('flags a variance at or above the 1% tolerance', () => {
    const result = normalizeProviderUsageVariance({ providerBilledSeconds: 6060, estimatedUnits: 100 })
    // 6060s -> ceil(101) minutes = 101 units vs estimated 100 -> 1% variance, not within (strict <)
    expect(result.actualUnits).toBe(101)
    expect(result.varianceRatio).toBeCloseTo(0.01, 5)
    expect(result.withinTolerance).toBe(false)
  })

  it('treats a zero-estimate/zero-actual pair as zero variance, and zero-estimate/nonzero-actual as maximal variance', () => {
    expect(normalizeProviderUsageVariance({ providerBilledSeconds: 0, estimatedUnits: 0 }).varianceRatio).toBe(0)
    expect(normalizeProviderUsageVariance({ providerBilledSeconds: 60, estimatedUnits: 0 }).varianceRatio).toBe(1)
  })

  it('property: varianceRatio is always non-negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 10_000 }), (seconds, estimatedUnits) => {
        const result = normalizeProviderUsageVariance({ providerBilledSeconds: seconds, estimatedUnits })
        expect(result.varianceRatio).toBeGreaterThanOrEqual(0)
      }),
    )
  })
})

describe('boundary: no local grant/ledger state machine', () => {
  it('this module never re-exports or reimplements the platform reservation lifecycle', () => {
    const forbiddenNames = ['reserveCredits', 'extendReservation', 'settleReservation', 'releaseReservation', 'heartbeatReservation']
    const exportedNames = Object.keys(interviewBilling)
    for (const name of forbiddenNames) {
      expect(exportedNames).not.toContain(name)
      expect(name in reservations).toBe(true) // sanity: confirms these really are the platform's own names
    }
  })

  it('this module never re-exports or reimplements the platform credit-grant lifecycle', () => {
    const forbiddenNames = ['grantCredits', 'expireCreditGrant', 'freezeCreditGrant', 'unfreezeCreditGrant', 'revokeCreditGrant', 'adjustCreditGrant']
    const exportedNames = Object.keys(interviewBilling)
    for (const name of forbiddenNames) {
      expect(exportedNames).not.toContain(name)
      expect(name in credits).toBe(true)
    }
  })
})
